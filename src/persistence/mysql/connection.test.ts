import { describe, expect, it } from "vitest";

import {
  MySqlConfigurationError,
  readMySqlConnectionConfig,
} from "./connection";

describe("readMySqlConnectionConfig", () => {
  it("parses a bounded MySQL pool configuration", () => {
    expect(
      readMySqlConnectionConfig({
        MYSQL_DATABASE_URL:
          "mysql://im_inspect:secret@127.0.0.1:3306/im_inspect",
        MYSQL_POOL_LIMIT: "12",
      }),
    ).toEqual({
      databaseUrl: "mysql://im_inspect:secret@127.0.0.1:3306/im_inspect",
      connectionLimit: 12,
    });
  });

  it("rejects missing, non-MySQL and unbounded configuration", () => {
    expect(() => readMySqlConnectionConfig({})).toThrow(
      MySqlConfigurationError,
    );
    expect(() =>
      readMySqlConnectionConfig({
        MYSQL_DATABASE_URL: "postgresql://localhost/im_inspect",
      }),
    ).toThrow(MySqlConfigurationError);
    expect(() =>
      readMySqlConnectionConfig({
        MYSQL_DATABASE_URL: "mysql://localhost/im_inspect",
        MYSQL_POOL_LIMIT: "100",
      }),
    ).toThrow(MySqlConfigurationError);
  });

  it("does not include credentials in configuration errors", () => {
    const secret = "should-not-leak";
    try {
      readMySqlConnectionConfig({
        MYSQL_DATABASE_URL: `mysql://user:${secret}@localhost/db`,
        MYSQL_POOL_LIMIT: "invalid",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
