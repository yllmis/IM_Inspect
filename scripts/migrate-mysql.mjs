import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createConnection } from "mysql2/promise";

const databaseUrl = process.env.MYSQL_DATABASE_URL;
if (!databaseUrl?.startsWith("mysql://")) {
  throw new Error("MYSQL_DATABASE_URL must be configured with mysql://");
}

const migrationDirectory = path.join(process.cwd(), "migrations", "mysql");
const connection = await createConnection({
  uri: databaseUrl,
  multipleStatements: true,
  timezone: "Z",
});

try {
  await connection.query(
    [
      "CREATE TABLE IF NOT EXISTS schema_migrations (",
      "name VARCHAR(255) NOT NULL PRIMARY KEY,",
      "checksum CHAR(64) NOT NULL,",
      "applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
      ") ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_bin",
    ].join(" "),
  );

  const files = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const sql = await readFile(path.join(migrationDirectory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const [rows] = await connection.execute(
      "SELECT checksum FROM schema_migrations WHERE name = ? LIMIT 1",
      [name],
    );
    if (rows.length > 0) {
      if (rows[0].checksum !== checksum) {
        throw new Error(`applied migration checksum changed: ${name}`);
      }
      continue;
    }

    await connection.beginTransaction();
    try {
      await connection.query(sql);
      await connection.execute(
        "INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)",
        [name, checksum],
      );
      await connection.commit();
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
} finally {
  await connection.end();
}
