import { NextResponse } from "next/server";
import { z } from "zod";

import { DraftWorkflowError } from "../application/escalation-draft-workflow";
import { MySqlConfigurationError } from "../persistence/mysql/connection";
import { DraftSecurityError } from "../tools/escalation-draft-service";
import { AuthenticationError } from "./principal";

export function draftRouteError(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "invalid_argument" }, { status: 400 });
  }
  if (error instanceof MySqlConfigurationError) {
    return NextResponse.json(
      { error: "database_not_configured" },
      { status: 503 },
    );
  }
  if (error instanceof DraftWorkflowError) {
    const status = error.code === "session_not_found" ? 404 : 409;
    return NextResponse.json({ error: error.code }, { status });
  }
  if (error instanceof DraftSecurityError) {
    const status = error.code === "permission_denied" ? 403 : 409;
    return NextResponse.json({ error: error.code }, { status });
  }
  return NextResponse.json(
    { error: "draft_operation_failed" },
    { status: 500 },
  );
}
