"use client";

import { FormEvent, useMemo, useState } from "react";

type ChatMessage = { role: "support" | "agent"; text: string; time: string };
type Diagnosis = {
  classification?: string;
  facts?: string[];
  evidence?: Array<{
    id: string;
    source: string;
    kind: string;
    field: string;
    value: string | number | boolean | null;
    observedAt: string;
  }>;
  possibleCauses?: string[];
  missingInformation?: string[];
  recommendedAction?: string;
};
type TraceStep = {
  type: string;
  action?: string;
  name?: string;
  outcome: string;
  durationMs: number;
  errorCode?: string;
  attempts?: number;
};
type AgentResult = {
  sessionId: string;
  stateVersion: number;
  status: string;
  reply: string;
  diagnosis: Diagnosis;
  candidateContext?: Record<string, unknown>;
  trace?: { runId: string; steps: TraceStep[]; totalDurationMs: number };
};

const classificationLabels: Record<string, string> = {
  message_not_found: "消息不存在",
  write_failed: "写入失败",
  not_delivered: "未确认投递",
  receiver_offline: "接收方离线",
  ack_timeout: "ACK 超时",
  delivered: "已投递",
  insufficient_data: "证据不足",
};
const toolLabels: Record<string, string> = {
  find_user_or_message: "定位用户 / 消息",
  get_message_status: "读取消息状态",
  get_delivery_events: "读取投递事件",
  get_connection_status: "读取连接状态",
};
const examples = [
  "查询消息 msg_001 的投递情况",
  "用户 user_007 说消息没有收到",
  "检查 msg_001 是否写入成功",
];

function newSessionId() {
  return `session_${Math.random().toString(36).slice(2, 10)}`;
}
function clock() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}
function jsonValue(value: unknown) {
  return value === null
    ? "null"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}

export default function HomePage() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "agent",
      text: "告诉我消息 ID、用户或会话，以及客服看到的异常现象。",
      time: clock(),
    },
  ]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [showTrace, setShowTrace] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmationToken, setConfirmationToken] = useState("");
  const [draftState, setDraftState] = useState<
    "idle" | "preparing" | "ready" | "confirmed" | "error"
  >("idle");
  const [draftMessage, setDraftMessage] = useState("");
  const diagnosis = result?.diagnosis;
  const traceSteps = result?.trace?.steps ?? [];
  const toolSteps = traceSteps.filter((step) => step.type === "tool");
  const messageId = useMemo(
    () =>
      typeof result?.candidateContext?.messageId === "string"
        ? result.candidateContext.messageId
        : "未确定",
    [result],
  );
  const canEscalate = diagnosis?.recommendedAction === "escalate";

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || running) return;
    setQuestion("");
    setError("");
    setRunning(true);
    setMessages((current) => [
      ...current,
      { role: "support", text, time: clock() },
    ]);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });
      const payload = (await response.json()) as AgentResult & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error ?? "agent_execution_failed");
      setResult(payload);
      setMessages((current) => [
        ...current,
        { role: "agent", text: payload.reply, time: clock() },
      ]);
      setDraft("");
      setConfirmationToken("");
      setDraftState("idle");
      setDraftMessage("");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "请求失败";
      setError(message);
      setMessages((current) => [
        ...current,
        { role: "agent", text: `本次诊断未完成：${message}`, time: clock() },
      ]);
    } finally {
      setRunning(false);
    }
  }

  function resetSession() {
    setSessionId(newSessionId());
    setMessages([
      {
        role: "agent",
        text: "新的诊断会话已准备好。请输入客服问题。",
        time: clock(),
      },
    ]);
    setResult(null);
    setError("");
    setDraft("");
    setConfirmationToken("");
    setDraftState("idle");
    setDraftMessage("");
  }

  async function prepareDraft() {
    if (!result || !draft.trim()) return;
    setDraftState("preparing");
    setDraftMessage("");
    try {
      const response = await fetch("/api/escalation-drafts/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId, summary: draft.trim() }),
      });
      const payload = (await response.json()) as {
        confirmationToken?: string;
        error?: string;
      };
      if (!response.ok || !payload.confirmationToken)
        throw new Error(payload.error ?? "无法生成确认令牌");
      setConfirmationToken(payload.confirmationToken);
      setDraftState("ready");
      setDraftMessage("草稿已锁定，等待客服确认。");
    } catch (caught) {
      setDraftState("error");
      setDraftMessage(
        caught instanceof Error ? caught.message : "草稿准备失败",
      );
    }
  }

  async function confirmDraft() {
    if (!confirmationToken) return;
    setDraftState("preparing");
    try {
      const response = await fetch("/api/escalation-drafts/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId, confirmationToken }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "确认失败");
      setDraftState("confirmed");
      setDraftMessage("升级单草稿已保存，令牌已消费。");
      setConfirmationToken("");
    } catch (caught) {
      setDraftState("error");
      setDraftMessage(caught instanceof Error ? caught.message : "确认失败");
    }
  }

  return (
    <main className="workspace-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">/</span>
          <span>IM Inspect</span>
          <span className="env-dot" />
        </div>
        <div className="sidebar-section-label">工作台</div>
        <button className="nav-item active" type="button">
          <span className="nav-icon">+</span>新建诊断
          <span className="nav-key">⌘ N</span>
        </button>
        <div className="sidebar-section-label recent-label">最近会话</div>
        <div className="recent-session">
          <span className="status-pip" />
          <div>
            <strong>{messageId}</strong>
            <small>{result ? "刚刚更新" : "等待输入"}</small>
          </div>
        </div>
        <div className="sidebar-note">
          <span className="lock">⌑</span>
          <div>
            <strong>受控诊断</strong>
            <small>事实来自工具，分类由规则引擎决定。</small>
          </div>
        </div>
        <button className="new-session" onClick={resetSession} type="button">
          <span>↻</span> 重置会话
        </button>
        <div className="sidebar-footer">
          <span className="avatar">CS</span>
          <div>
            <strong>演示客服</strong>
            <small>tenant_demo</small>
          </div>
          <span className="more">•••</span>
        </div>
      </aside>

      <section className="main-column">
        <header className="topbar">
          <div>
            <span className="eyebrow">客服诊断工作台</span>
            <h1>消息异常排查</h1>
          </div>
          <div className="topbar-meta">
            <span className="live-badge">
              <i />
              服务在线
            </span>
            <span className="session-code">{sessionId}</span>
          </div>
        </header>
        <div className="conversation-scroll">
          <div className="intro-strip">
            <div className="intro-number">01</div>
            <div>
              <strong>从一个问题开始</strong>
              <span>
                输入客服收到的描述，Agent 会提取对象并查询可验证证据。
              </span>
            </div>
            <span className="intro-rule" />
          </div>
          <div className="conversation-list">
            {messages.map((message, index) => (
              <div
                className={`message-row ${message.role}`}
                key={`${message.time}-${index}`}
              >
                <div className="message-avatar">
                  {message.role === "agent" ? "AI" : "你"}
                </div>
                <div className="message-body">
                  <div className="message-meta">
                    <strong>
                      {message.role === "agent" ? "诊断 Agent" : "客服"}
                    </strong>
                    <span>{message.time}</span>
                  </div>
                  <p>{message.text}</p>
                </div>
              </div>
            ))}
            {running && (
              <div className="message-row agent">
                <div className="message-avatar loading-avatar">···</div>
                <div className="message-body">
                  <div className="message-meta">
                    <strong>诊断 Agent</strong>
                    <span>处理中</span>
                  </div>
                  <div className="thinking-line">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            )}
          </div>
          {error && (
            <div className="error-banner">
              <span>!</span>
              <div>
                <strong>请求未完成</strong>
                <small>{error}</small>
              </div>
            </div>
          )}
          <form className="composer" onSubmit={ask}>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：查询 msg_001 的投递状态……"
              rows={3}
              disabled={running}
            />
            <div className="composer-footer">
              <span className="composer-hint">
                Enter 发送 · Shift + Enter 换行
              </span>
              <button
                className="send-button"
                type="submit"
                disabled={running || !question.trim()}
              >
                {running ? "诊断中" : "开始诊断"}
                <span>↗</span>
              </button>
            </div>
          </form>
          <div className="example-row">
            <span>试试</span>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuestion(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </section>

      <aside className="inspector">
        <div className="inspector-header">
          <div>
            <span className="eyebrow">诊断上下文</span>
            <h2>证据面板</h2>
          </div>
          <span className={`context-status ${result ? "ready" : "idle"}`}>
            {result ? "已更新" : "待运行"}
          </span>
        </div>
        <div className="inspector-scroll">
          <section className="panel-section target-section">
            <div className="section-heading">
              <span className="section-index">A</span>
              <h3>诊断对象</h3>
            </div>
            <div className="target-card">
              <span className="target-label">MESSAGE ID</span>
              <strong>{messageId}</strong>
              <span className="target-sub">
                {result?.stateVersion
                  ? `会话版本 v${result.stateVersion}`
                  : "等待从客服问题中提取"}
              </span>
            </div>
          </section>
          <section className="panel-section">
            <div className="section-heading">
              <span className="section-index">B</span>
              <h3>工具进度</h3>
              <span className="section-count">{toolSteps.length || 0}</span>
            </div>
            {toolSteps.length ? (
              <div className="tool-list">
                {toolSteps.map((step, index) => (
                  <div className="tool-row" key={`${step.name}-${index}`}>
                    <span className={`tool-state ${step.outcome}`}>
                      {step.outcome === "success"
                        ? "✓"
                        : step.outcome === "cached"
                          ? "↺"
                          : "!"}
                    </span>
                    <div>
                      <strong>
                        {toolLabels[step.name ?? ""] ?? step.name}
                      </strong>
                      <small>
                        {step.durationMs} ms{" "}
                        {step.attempts && step.attempts > 1
                          ? `· ${step.attempts} 次尝试`
                          : ""}
                      </small>
                    </div>
                    <span className="tool-outcome">
                      {step.outcome === "success"
                        ? "完成"
                        : step.outcome === "cached"
                          ? "复用"
                          : (step.errorCode ?? "异常")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-inline">运行诊断后显示查询轨迹</div>
            )}
          </section>
          <section className="panel-section">
            <div className="section-heading">
              <span className="section-index">C</span>
              <h3>确定事实</h3>
              <span className="section-count">
                {diagnosis?.facts?.length ?? 0}
              </span>
            </div>
            {diagnosis?.facts?.length ? (
              <ul className="fact-list">
                {diagnosis.facts.map((fact) => (
                  <li key={fact}>
                    <span>✓</span>
                    {fact}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-inline">尚未形成已确认事实</div>
            )}
          </section>
          <section className="panel-section">
            <div className="section-heading">
              <span className="section-index">D</span>
              <h3>证据来源</h3>
              <span className="section-count">
                {diagnosis?.evidence?.length ?? 0}
              </span>
            </div>
            {diagnosis?.evidence?.length ? (
              <div className="evidence-list">
                {diagnosis.evidence.map((item) => (
                  <div className="evidence-card" key={item.id}>
                    <div className="evidence-top">
                      <span className={`evidence-kind ${item.kind}`}>
                        {item.kind}
                      </span>
                      <time>
                        {new Date(item.observedAt).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <strong>{item.field}</strong>
                    <small>{item.source}</small>
                    <code>{jsonValue(item.value)}</code>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-inline">工具返回的证据会显示在这里</div>
            )}
          </section>
          {diagnosis && (
            <section className="diagnosis-card">
              <div className="diagnosis-card-top">
                <span className="eyebrow">确定性分类</span>
                <span className="deterministic">RULE ENGINE</span>
              </div>
              <strong>
                {classificationLabels[diagnosis.classification ?? ""] ??
                  diagnosis.classification}
              </strong>
              <p>
                {diagnosis.possibleCauses?.[0] ??
                  diagnosis.missingInformation?.[0] ??
                  "分类由诊断引擎根据已确认事实生成。"}
              </p>
            </section>
          )}
          {canEscalate && (
            <section className="panel-section draft-section">
              <div className="section-heading">
                <span className="section-index">E</span>
                <h3>升级单草稿</h3>
                <span className="human-badge">需人工确认</span>
              </div>
              <textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (confirmationToken) {
                    setConfirmationToken("");
                    setDraftState("idle");
                    setDraftMessage("内容已修改，需要重新准备确认。");
                  }
                }}
                placeholder="编辑给研发的升级摘要…"
                rows={5}
              />
              <div className="draft-actions">
                <button
                  type="button"
                  onClick={prepareDraft}
                  disabled={!draft.trim() || draftState === "preparing"}
                >
                  {draftState === "preparing"
                    ? "处理中…"
                    : confirmationToken
                      ? "重新准备"
                      : "准备确认"}
                </button>
                {confirmationToken && (
                  <button
                    className="confirm-button"
                    type="button"
                    onClick={confirmDraft}
                  >
                    确认保存
                  </button>
                )}
              </div>
              {draftMessage && (
                <small className={`draft-message ${draftState}`}>
                  {draftMessage}
                </small>
              )}
            </section>
          )}
          <section className="trace-section">
            <button
              type="button"
              className="trace-toggle"
              onClick={() => setShowTrace((value) => !value)}
            >
              <span>⌁</span>
              <strong>查看 Trace</strong>
              <span className="trace-meta">
                {result?.trace
                  ? `${result.trace.totalDurationMs} ms · ${traceSteps.length} steps`
                  : "尚未运行"}
              </span>
              <span className="chevron">{showTrace ? "⌃" : "⌄"}</span>
            </button>
            {showTrace && result?.trace && (
              <div className="trace-body">
                <div className="trace-run">
                  <span>RUN</span>
                  <code>{result.trace.runId}</code>
                </div>
                {traceSteps.map((step, index) => (
                  <div className="trace-step" key={`${step.type}-${index}`}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>
                        {step.type === "tool"
                          ? step.name
                          : (step.action ?? step.type)}
                      </strong>
                      <small>
                        {step.outcome} · {step.durationMs} ms
                        {step.errorCode ? ` · ${step.errorCode}` : ""}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </main>
  );
}
