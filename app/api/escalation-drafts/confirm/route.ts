import { NextResponse } from "next/server";

import { ConfirmEscalationDraftApiSchema } from "../../../../src/application/escalation-draft-workflow";
import { draftRouteError } from "../../../../src/server/draft-route-response";
import { getEscalationDraftWorkflow } from "../../../../src/server/escalation-draft-runtime";
import { authenticateDemoSupportRequest } from "../../../../src/server/principal";

export async function POST(request: Request) {
  try {
    const principal = authenticateDemoSupportRequest(request);
    const input = ConfirmEscalationDraftApiSchema.parse(
      await request.json().catch(() => undefined),
    );
    const confirmed = await getEscalationDraftWorkflow().confirm(
      input,
      principal,
    );
    return NextResponse.json(confirmed);
  } catch (error) {
    return draftRouteError(error);
  }
}
