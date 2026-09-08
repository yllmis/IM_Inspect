import { createPool, type Pool } from "mysql2/promise";
import { z } from "zod";

const MySqlDatabaseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("mysql://"), {
    message: "MYSQL_DATABASE_URL must use the mysql:// protocol",
  });

export const MySqlConnectionConfigSchema = z
  .object({
    databaseUrl: MySqlDatabaseUrlSchema,
    connectionLimit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export type MySqlConnectionConfig = z.infer<typeof MySqlConnectionConfigSchema>;

export class MySqlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MySqlConfigurationError";
  }
}

export function readMySqlConnectionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MySqlConnectionConfig {
  const parsed = MySqlConnectionConfigSchema.safeParse({
    databaseUrl: environment.MYSQL_DATABASE_URL,
    connectionLimit: environment.MYSQL_POOL_LIMIT
      ? Number(environment.MYSQL_POOL_LIMIT)
      : undefined,
  });
  if (!parsed.success) {
    throw new MySqlConfigurationError(
      "MySQL configuration is missing or invalid",
    );
  }
  return parsed.data;
}

export function createMySqlPool(config: MySqlConnectionConfig): Pool {
  const parsed = MySqlConnectionConfigSchema.parse(config);
  return createPool({
    uri: parsed.databaseUrl,
    waitForConnections: true,
    connectionLimit: parsed.connectionLimit,
    queueLimit: 100,
    timezone: "Z",
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}
