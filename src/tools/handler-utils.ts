import { z } from "zod";

import { ConnectorResult } from "../connectors/connector";
import { ToolError } from "../domain/errors";
import { ToolServiceError } from "./context";

export function requireCapability(
  connector: { getCapabilities(): Record<string, string> },
  capability: string,
) {
  if (connector.getCapabilities()[capability] === "unsupported") {
    throw new ToolServiceError(
      "unsupported_capability",
      `${capability} is not supported by this connector`,
      false,
      { capability },
    );
  }
}

export function unwrapConnector<T>(result: ConnectorResult<T>): T {
  if (!result.ok) {
    const error: ToolError = result.error;
    throw new ToolServiceError(
      error.code,
      error.message,
      error.retryable,
      error.details,
    );
  }
  return result.data;
}

export function parseResult<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
