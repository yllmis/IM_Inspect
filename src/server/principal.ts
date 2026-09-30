import { timingSafeEqual } from "node:crypto";

import { AuthenticatedPrincipal } from "../application/escalation-draft-workflow";

export class AuthenticationError extends Error {
  constructor() {
    super("request is not authenticated");
    this.name = "AuthenticationError";
  }
}

/**
 * MVP 认证适配器：Bearer Token 只在服务端环境变量中配置。
 * 后续接公司登录系统时替换本函数，Workflow 无需改动。
 */
export function authenticateDemoSupportRequest(
  request: Request,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthenticatedPrincipal {
  // 仅用于本地工作台演示：生产环境永远不能绕过 Bearer/JWT 认证。
  if (
    environment.DEMO_SUPPORT_AUTO_AUTH === "true" &&
    environment.NODE_ENV !== "production"
  ) {
    return demoPrincipal();
  }
  const expected = environment.DEMO_SUPPORT_API_TOKEN;
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!expected || !supplied || !safeEqual(expected, supplied)) {
    throw new AuthenticationError();
  }
  return demoPrincipal();
}

function demoPrincipal(): AuthenticatedPrincipal {
  return {
    tenantId: "tenant_demo",
    actorId: "support_demo",
    permissions: ["escalation:draft:create", "diagnosis:trace:read"],
  };
}

function safeEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
