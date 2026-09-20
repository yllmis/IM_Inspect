import { NextResponse } from "next/server";

import { queryTrace } from "../../../../src/agent/trace-query";
import { getTraceStore } from "../../../../src/server/trace-runtime";
import { authenticateDemoSupportRequest } from "../../../../src/server/principal";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

/** 只读 Trace 查询：不返回完整 Prompt、响应或凭证。 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const principal = authenticateDemoSupportRequest(request);
    if (!principal.permissions.includes("diagnosis:trace:read")) {
      return NextResponse.json({ error: "permission_denied" }, { status: 403 });
    }
    const { runId } = await context.params;
    const trace = await getTraceStore().get(principal, runId);
    if (!trace)
      return NextResponse.json({ error: "trace_not_found" }, { status: 404 });
    return NextResponse.json(queryTrace(trace));
  } catch {
    return NextResponse.json({ error: "trace_query_failed" }, { status: 400 });
  }
}
