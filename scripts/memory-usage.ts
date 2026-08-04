import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { MemoryRepository } from "../src/db/repository.js";
import { usageMetrics } from "../src/types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const repository = new MemoryRepository(pool, config.ownerId, {
    maxMemoryContentChars: config.maxMemoryContentChars,
    maxCheckpointContentChars: config.maxCheckpointContentChars,
    sessionRetentionDays: config.sessionRetentionDays,
  });

  try {
    const counters = new Map(
      (await repository.getUsage()).map((counter) => [counter.metric, counter]),
    );

    console.log(`Agent memory usage for ${config.ownerId}`);
    console.table(
      usageMetrics.map((metric) => {
        const counter = counters.get(metric);
        return {
          metric: metric.replaceAll("_", " "),
          count: counter?.count ?? 0,
          updatedAt: counter?.updatedAt ?? "never",
        };
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unable to read memory usage",
  );
  process.exitCode = 1;
});
