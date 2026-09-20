import { describe, expect, it } from "vitest";

import {
  authenticateDemoSupportRequest,
  AuthenticationError,
} from "./principal";

describe("authenticateDemoSupportRequest", () => {
  const environment = { DEMO_SUPPORT_API_TOKEN: "server-secret-token" };

  it("rejects missing and invalid credentials", () => {
    expect(() =>
      authenticateDemoSupportRequest(
        new Request("http://localhost/api/escalation-drafts/prepare"),
        environment,
      ),
    ).toThrow(AuthenticationError);
    expect(() =>
      authenticateDemoSupportRequest(
        new Request("http://localhost/api/escalation-drafts/prepare", {
          headers: { authorization: "Bearer forged-token" },
        }),
        environment,
      ),
    ).toThrow(AuthenticationError);
  });

  it("derives identity and permission from server configuration", () => {
    const request = new Request(
      "http://localhost/api/escalation-drafts/prepare",
      {
        headers: {
          authorization: "Bearer server-secret-token",
          "x-actor-id": "forged-admin",
          "x-tenant-id": "forged-tenant",
        },
      },
    );
    expect(authenticateDemoSupportRequest(request, environment)).toEqual({
      tenantId: "tenant_demo",
      actorId: "support_demo",
      permissions: ["escalation:draft:create", "diagnosis:trace:read"],
    });
  });
});
