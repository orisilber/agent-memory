import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { MemoryRepository } from "./db/repository.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.databaseUrl);

  const pool = createPool(config.databaseUrl);
  const repository = new MemoryRepository(pool, config.ownerId, {
    maxMemoryContentChars: config.maxMemoryContentChars,
    maxCheckpointContentChars: config.maxCheckpointContentChars,
    sessionRetentionDays: config.sessionRetentionDays,
    searchBypassMaxScopeSize: config.searchBypassMaxScopeSize,
  });
  await repository.cleanupExpired();
  const cleanupTimer = setInterval(
    () => {
      void repository.cleanupExpired().catch((error: unknown) => {
        console.error("Expired memory cleanup failed:", error);
      });
    },
    60 * 60 * 1000,
  );
  cleanupTimer.unref();
  const { server, closeSessions } = createHttpServer(
    repository,
    config,
    async () => {
      await pool.query("SELECT 1");
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  console.log(
    `Agent memory MCP listening on http://${config.host}:${config.port}`,
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`Received ${signal}; shutting down.`);
    clearInterval(cleanupTimer);
    await closeSessions();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Shutdown failed:", error);
        process.exit(1);
      },
    );
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Shutdown failed:", error);
        process.exit(1);
      },
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("Agent memory failed to start:", error);
    process.exitCode = 1;
  });
}
