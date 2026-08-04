import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export async function runMigrations(
  databaseUrl: string,
  directory = migrationsDirectory,
): Promise<void> {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/u, "");
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version],
      );
      if (applied.rowCount) {
        continue;
      }

      const sql = await readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  runMigrations(config.databaseUrl)
    .then(() => {
      console.log("Database migrations complete.");
    })
    .catch((error: unknown) => {
      console.error("Database migration failed:", error);
      process.exitCode = 1;
    });
}
