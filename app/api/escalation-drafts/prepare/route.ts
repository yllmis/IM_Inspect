import { NextResponse } from "next/server";

import { PrepareEscalationDraftApiSchema } from "../../../../src/application/escalation-draft-workflow";
import { draftRouteError } from "../../../../src/server/draft-route-response";
import { getEscalationDraftWorkflow } from "../../../../src/server/escalation-draft-runtime";
import { authenticateDemoSupportRequest } from "../../../../src/server/principal";

export async function POST(request: Request) {
  try {
    const principal = authenticateDemoSupportRequest(request);
    const input = PrepareEscalationDraftApiSchema.parse(
      await request.json().catch(() => undefined),
    );
    const prepared = await getEscalationDraftWorkflow().prepare(
      input,
      principal,
    );
    return NextResponse.json(prepared, { status: 201 });
  } catch (error) {
    return draftRouteError(error);
  }
}
