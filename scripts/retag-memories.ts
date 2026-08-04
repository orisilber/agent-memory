import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { tagsWithDerived } from "../src/tags.js";

function resolveDatabaseUrl(): string {
  const explicitUrl = process.env.MEMORY_RETAG_DATABASE_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const user = encodeURIComponent(process.env.POSTGRES_USER ?? "memory");
  const password = encodeURIComponent(
    process.env.POSTGRES_PASSWORD ?? "memory",
  );
  const database = encodeURIComponent(
    process.env.POSTGRES_DB ?? "agent_memory",
  );
  const port = process.env.POSTGRES_PORT ?? "5433";
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
}

function sameTags(current: string[], next: string[]): boolean {
  return (
    current.length === next.length &&
    current.every((tag, index) => tag === next[index])
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const pool = createPool(resolveDatabaseUrl());

  try {
    const existing = await pool.query(
      "SELECT id, title, content, tags FROM memories WHERE owner_id = $1",
      [config.ownerId],
    );

    let changed = 0;
    for (const row of existing.rows) {
      const current = (row.tags as string[] | null) ?? [];
      const next = tagsWithDerived({
        title: String(row.title),
        content: String(row.content),
        tags: current,
      });
      if (sameTags(current, next)) {
        continue;
      }

      changed += 1;
      const added = next.filter((tag) => !current.includes(tag));
      console.log(`${row.id}: + ${added.join(", ")}`);
      if (!dryRun) {
        // Deliberately leaves updated_at alone so recency ranking is preserved;
        // the search_document trigger still fires on a tags update.
        await pool.query("UPDATE memories SET tags = $1 WHERE id = $2", [
          next,
          row.id,
        ]);
      }
    }

    console.log(
      `${dryRun ? "Would retag" : "Retagged"} ${changed} of ${existing.rowCount ?? 0} memories for ${config.ownerId}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unable to retag memories",
  );
  process.exitCode = 1;
});
