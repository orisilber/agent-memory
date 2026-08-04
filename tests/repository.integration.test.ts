import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { MemoryRepository } from "../src/db/repository.js";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://memory:memory@localhost:5433/agent_memory";
const ownerId = `test-${randomUUID()}`;
const pool = createPool(databaseUrl);
const repository = new MemoryRepository(pool, ownerId, {
  maxMemoryContentChars: 12_000,
  maxCheckpointContentChars: 12_000,
});

suite("MemoryRepository integration", () => {
  beforeAll(async () => {
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM memories WHERE owner_id = $1", [ownerId]);
    await pool.query("DELETE FROM loop_runs WHERE owner_id = $1", [ownerId]);
    await pool.end();
  });

  it("isolates session, repo, and global search", async () => {
    await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "preference",
      title: "Package manager",
      content: "Use pnpm for JavaScript projects.",
      tags: ["tooling"],
      metadata: {},
      provenance: { source: "test" },
      confidence: 1,
      importance: 0.8,
      expiresAt: null,
    });
    await repository.storeMemory({
      scopeType: "repo",
      context: { repoId: "github.com/example/memory" },
      kind: "procedure",
      title: "Test command",
      content: "Run repository tests with npm run test.",
      tags: ["testing"],
      metadata: {},
      provenance: { source: "test" },
      confidence: 0.9,
      importance: 0.7,
      expiresAt: null,
    });
    const sessionMemory = await repository.storeMemory({
      scopeType: "session",
      context: { sessionId: "session-a" },
      kind: "fact",
      title: "Current task",
      content: "Current task uses Docker Compose.",
      tags: ["loop"],
      metadata: {},
      provenance: { source: "test" },
      confidence: 1,
      importance: 0.5,
      expiresAt: null,
    });
    const sessionExpiry = Date.parse(sessionMemory.memory.expiresAt ?? "");
    expect(sessionMemory.memory.expiresAt).not.toBeNull();
    expect(sessionExpiry - Date.now()).toBeGreaterThan(
      2 * 24 * 60 * 60 * 1000 - 10_000,
    );
    expect(sessionExpiry - Date.now()).toBeLessThanOrEqual(
      2 * 24 * 60 * 60 * 1000 + 1_000,
    );

    const repoResults = await repository.searchMemories({
      scopes: ["repo"],
      context: { repoId: "github.com/example/memory" },
      query: "repository tests",
      limit: 10,
    });
    expect(repoResults).toHaveLength(1);
    expect(repoResults[0]?.scopeType).toBe("repo");

    const sessionResults = await repository.searchMemories({
      scopes: ["session"],
      context: {
        sessionId: "session-a",
        repoId: "github.com/example/memory",
      },
      query: "Docker Compose",
      limit: 10,
    });
    expect(sessionResults).toHaveLength(1);
    expect(sessionResults[0]?.scopeType).toBe("session");

    const repoOnlyForDocker = await repository.searchMemories({
      scopes: ["repo"],
      context: { repoId: "github.com/example/memory" },
      query: "Docker Compose",
      limit: 10,
    });
    expect(repoOnlyForDocker).toHaveLength(0);
  });

  it("deduplicates same normalized memory within scope", async () => {
    const first = await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "decision",
      title: "First title",
      content: "Keep memory content stable.",
      tags: [],
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.5,
      expiresAt: null,
    });
    const second = await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "decision",
      title: "Updated title",
      content: "  Keep   memory content stable. ",
      tags: ["updated"],
      metadata: { source: "second write" },
      provenance: {},
      confidence: 0.8,
      importance: 0.9,
      expiresAt: null,
    });

    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.title).toBe("Updated title");
    expect(second.memory.tags).toEqual(["updated"]);
    expect(second.memory.importance).toBe(0.9);
  });

  it("resumes and finishes loop checkpoints", async () => {
    const run = await repository.startLoop({
      sessionId: "loop-session",
      repoId: "github.com/example/memory",
      task: "Run integration flow",
    });
    expect(run.expiresAt).not.toBeNull();
    expect(Date.parse(run.expiresAt ?? "")).toBeGreaterThan(Date.now());
    await pool.query(
      "UPDATE loop_runs SET expires_at = now() + interval '1 hour' WHERE id = $1",
      [run.id],
    );
    const checkpoint = await repository.checkpointLoop({
      runId: run.id,
      step: 1,
      completedSummary: "Started database and created test records.",
      artifacts: ["memory-id"],
      errors: [],
      state: { records: 1 },
      nextAction: "Run search assertion",
      idempotencyKey: "step-1",
    });

    const resumed = await repository.resumeLoop(
      run.id,
      "loop-session",
      "github.com/example/memory",
    );
    expect(resumed?.run.id).toBe(run.id);
    expect(resumed?.checkpoint?.id).toBe(checkpoint.checkpoint.id);
    expect(resumed?.checkpoint?.nextAction).toBe("Run search assertion");
    expect(
      Date.parse(resumed?.run.expiresAt ?? "") - Date.now(),
    ).toBeGreaterThan(24 * 60 * 60 * 1000);

    const finished = await repository.finishLoop({
      runId: run.id,
      status: "completed",
      currentStep: 2,
    });
    expect(finished.status).toBe("completed");
    expect(
      await repository.resumeLoop(
        run.id,
        "loop-session",
        "github.com/example/memory",
      ),
    ).toBeNull();
  });

  it("archives memories and hides expired memories", async () => {
    const archived = await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "fact",
      title: "Archived fact",
      content: "This fact is archived after storage.",
      tags: [],
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.2,
      expiresAt: null,
    });
    expect(await repository.archiveMemory(archived.memory.id)).toBe(true);
    expect(
      await repository.listMemories({
        scopes: ["global"],
        context: {},
        limit: 10,
      }),
    ).not.toContainEqual(expect.objectContaining({ id: archived.memory.id }));

    const expired = await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "fact",
      title: "Expired fact",
      content: "This fact is already expired.",
      tags: [],
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.2,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      await repository.searchMemories({
        scopes: ["global"],
        context: {},
        query: "already expired",
        limit: 10,
      }),
    ).not.toContainEqual(expect.objectContaining({ id: expired.memory.id }));
  });

  it("forgets a memory by owner-scoped ID", async () => {
    const stored = await repository.storeMemory({
      scopeType: "session",
      context: { sessionId: "forget-session" },
      kind: "fact",
      title: "Temporary fact",
      content: "Delete this test memory.",
      tags: [],
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.1,
      expiresAt: null,
    });

    expect(await repository.forgetMemory(stored.memory.id)).toBe(true);
    expect(await repository.getMemory(stored.memory.id)).toBeNull();
  });
});
