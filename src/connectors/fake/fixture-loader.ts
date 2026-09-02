import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { ConnectionFactSchema } from "../../domain/connection";
import { DeliveryFactSchema } from "../../domain/delivery";
import { ToolErrorCodeSchema } from "../../domain/errors";
import { MessageFactSchema } from "../../domain/message";

const FixtureBehaviorSuccessSchema = z
  .object({ kind: z.literal("success") })
  .strict();
const FixtureBehaviorEmptySchema = z
  .object({ kind: z.literal("empty") })
  .strict();
const FixtureBehaviorErrorSchema = z
  .object({
    kind: z.literal("error"),
    code: ToolErrorCodeSchema,
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  })
  .strict();
const FixtureBehaviorUnsupportedSchema = z
  .object({
    kind: z.literal("unsupported"),
    capability: z.string().min(1).max(128),
  })
  .strict();

export const FixtureBehaviorSchema = z.discriminatedUnion("kind", [
  FixtureBehaviorSuccessSchema,
  FixtureBehaviorEmptySchema,
  FixtureBehaviorErrorSchema,
  FixtureBehaviorUnsupportedSchema,
]);
export type FixtureBehavior = z.infer<typeof FixtureBehaviorSchema>;

export const FixtureSourceSchema = z
  .object({
    kind: z.literal("fixture"),
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const FixtureSchema = z
  .object({
    fixtureVersion: z.literal(1),
    source: FixtureSourceSchema,
    message: MessageFactSchema,
    deliveries: z.array(DeliveryFactSchema),
    connection: ConnectionFactSchema.nullable(),
    behavior: z
      .object({
        getMessageStatus: FixtureBehaviorSchema,
        getDeliveryEvents: FixtureBehaviorSchema,
        getConnectionStatus: FixtureBehaviorSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (
      fixture.connection &&
      fixture.connection.userId !== fixture.message.receiverId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connection", "userId"],
        message: "connection userId must match message receiverId",
      });
    }
  });
export type Fixture = z.infer<typeof FixtureSchema>;

const DEFAULT_FIXTURE_DIRECTORY = resolve(process.cwd(), "eval/fixtures");

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freeze(nested);
    }
  }
  return value as Readonly<T>;
}

export function loadFixture(
  fixtureName: string,
  directory = DEFAULT_FIXTURE_DIRECTORY,
): Readonly<Fixture> {
  if (!/^[a-z0-9_]+$/.test(fixtureName)) {
    throw new Error("invalid fixture name");
  }

  const filePath = resolve(directory, `${fixtureName}.json`);
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return freeze(FixtureSchema.parse(raw));
}
