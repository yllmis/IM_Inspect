/* global fetch, AbortSignal */
import assert from "node:assert/strict";
import console from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";

// Smoke Test（冒烟测试）验证真实 HTTP、模型和持久化的最短链路。
// 只使用固定合成消息 ID；确认 Token 只在内存中流转，禁止输出或落入报告。
const baseUrl = "http://127.0.0.1:3000";
const sessionId = `demo-smoke-${randomUUID()}`;
const withDraft = process.argv.includes("--with-draft");
const headers = { "Content-Type": "application/json" };
if (process.env.DEMO_SUPPORT_API_TOKEN) {
  headers.authorization = `Bearer ${process.env.DEMO_SUPPORT_API_TOKEN}`;
}

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(135_000),
  });
  return { status: response.status, data: await response.json() };
}

try {
  const forged = await request("/api/chat", {
    text: "查询 msg_write_failed",
    tenantId: "admin",
    permissions: ["admin:all"],
  });
  assert.equal(forged.status, 400, "API must reject forged identity fields");
  console.log("forged_identity_rejected=passed");

  const first = await request("/api/chat", {
    sessionId,
    text: "请查询消息 msg_write_failed 的状态，并根据工具证据解释。",
  });
  assert.equal(
    first.status,
    200,
    `chat failed: ${first.data.error ?? "unknown"}`,
  );
  assert.equal(
    first.data.diagnosis.classification,
    "write_failed",
    "synthetic Fixture diagnosis mismatch",
  );
  assert.ok(
    first.data.toolCalls.some(
      (call) => call.name === "get_message_status" && call.response.ok,
    ),
  );
  assert.ok(first.data.diagnosis.evidence.length > 0);
  console.log("mimo_mysql_fake_diagnosis=passed");

  const second = await request("/api/chat", {
    sessionId,
    text: "继续说明这条消息已确认的故障和下一步处理，不要切换消息。",
  });
  assert.equal(second.status, 200);
  assert.ok(second.data.stateVersion > first.data.stateVersion);
  assert.equal(second.data.diagnosis.classification, "write_failed");
  console.log("multi_turn_state_reused=passed");

  const trace = await request(`/api/traces/${second.data.trace.runId}`);
  assert.equal(trace.status, 200, "Trace query must share the chat Run store");
  const replay = await request(`/api/traces/${second.data.trace.runId}/replay`);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.mode, "read_only_replay");
  assert.equal(replay.data.executedTools, false);
  console.log("trace_query_and_read_only_replay=passed");

  if (withDraft) {
    const prepared = await request("/api/escalation-drafts/prepare", {
      sessionId,
      summary: "本地合成 Fixture 演示：消息持久化失败，建议研发排查。",
    });
    assert.equal(prepared.status, 201);
    const body = {
      sessionId,
      confirmationToken: prepared.data.confirmationToken,
    };
    const created = await request("/api/escalation-drafts/confirm", body);
    const repeated = await request("/api/escalation-drafts/confirm", body);
    assert.equal(created.status, 200);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.reused, true);
    assert.equal(repeated.data.draft.draftId, created.data.draft.draftId);
    console.log("confirmed_draft_idempotent=passed");
  }
  console.log("local_smoke=passed");
} catch (error) {
  // 不打印服务端原始响应或异常对象，它们可能包含正文、凭证或内部堆栈。
  console.error(
    `local_smoke=failed: ${error instanceof Error ? error.message : "unknown"}`,
  );
  process.exitCode = 1;
}
