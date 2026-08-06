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
const bypassOwnerId = `test-bypass-${randomUUID()}`;
const pool = createPool(databaseUrl);
const repository = new MemoryRepository(pool, ownerId, {
  maxMemoryContentChars: 12_000,
  maxCheckpointContentChars: 12_000,
  searchBypassMaxScopeSize: 0,
});

suite("MemoryRepository integration", () => {
  beforeAll(async () => {
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    const owners = [ownerId, bypassOwnerId];
    await pool.query("DELETE FROM memories WHERE owner_id = ANY($1::text[])", [
      owners,
    ]);
    await pool.query("DELETE FROM loop_runs WHERE owner_id = ANY($1::text[])", [
      owners,
    ]);
    await pool.query(
      "DELETE FROM memory_usage_counters WHERE owner_id = ANY($1::text[])",
      [owners],
    );
    await pool.end();
  });

  it("isolates session, repo, and global search", async () => {
    await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "preference",
      title: "Package manager",
      content: "Use pnpm for JavaScript projects.",
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
    expect(repoResults.results).toHaveLength(1);
    expect(repoResults.results[0]?.scopeType).toBe("repo");
    expect(repoResults.scopeTotal).toBe(1);
    expect(repoResults.matchFilterApplied).toBe(true);

    const sessionResults = await repository.searchMemories({
      scopes: ["session"],
      context: {
        sessionId: "session-a",
        repoId: "github.com/example/memory",
      },
      query: "Docker Compose",
      limit: 10,
    });
    expect(sessionResults.results).toHaveLength(1);
    expect(sessionResults.results[0]?.scopeType).toBe("session");

    const repoOnlyForDocker = await repository.searchMemories({
      scopes: ["repo"],
      context: { repoId: "github.com/example/memory" },
      query: "Docker Compose",
      limit: 10,
    });
    expect(repoOnlyForDocker.results).toHaveLength(0);
    expect(repoOnlyForDocker.scopeTotal).toBe(1);
  });

  it("deduplicates same normalized memory within scope", async () => {
    const first = await repository.storeMemory({
      scopeType: "global",
      context: {},
      kind: "decision",
      title: "First title",
      content: "Keep memory content stable.",
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
      metadata: { source: "second write" },
      provenance: {},
      confidence: 0.8,
      importance: 0.9,
      expiresAt: null,
    });

    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.title).toBe("Updated title");
    expect(second.memory.importance).toBe(0.9);
  });

  it("tracks lifetime memory usage counters atomically", async () => {
    await pool.query("DELETE FROM memory_usage_counters WHERE owner_id = $1", [
      ownerId,
    ]);
    const suffix = randomUUID();
    const sessionId = `usage-session-${suffix}`;
    const stored = await repository.storeMemory({
      scopeType: "session",
      context: { sessionId },
      kind: "fact",
      title: `Usage test ${suffix}`,
      content: `Track usage for ${suffix}.`,
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.5,
      expiresAt: null,
    });

    await repository.searchMemories({
      scopes: ["session"],
      context: { sessionId },
      query: suffix,
      limit: 10,
    });
    await repository.searchMemories({
      scopes: ["session"],
      context: { sessionId },
      query: "qzxvjkmp",
      limit: 10,
    });
    await repository.listMemories({
      scopes: ["session"],
      context: { sessionId },
      limit: 10,
    });
    await repository.updateMemory({
      id: stored.memory.id,
      title: `Updated usage test ${suffix}`,
    });
    expect(await repository.archiveMemory(stored.memory.id)).toBe(true);
    expect(await repository.forgetMemory(stored.memory.id)).toBe(true);
    expect(await repository.forgetMemory(randomUUID())).toBe(false);

    await Promise.all([
      repository.incrementUsage("accessed"),
      repository.incrementUsage("accessed"),
    ]);

    const counters = new Map(
      (await repository.getUsage()).map((counter) => [
        counter.metric,
        counter.count,
      ]),
    );
    expect(counters.get("store_succeeded")).toBe(1);
    expect(counters.get("update_succeeded")).toBe(1);
    expect(counters.get("archive_succeeded")).toBe(1);
    expect(counters.get("forget_succeeded")).toBe(1);
    expect(counters.get("forget_failed")).toBe(1);
    expect(counters.get("search_succeeded")).toBe(2);
    expect(counters.get("search_missed")).toBe(1);
    expect(counters.get("list_succeeded")).toBe(1);
    expect(counters.get("accessed")).toBe(4);
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
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.2,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const expiredSearch = await repository.searchMemories({
      scopes: ["global"],
      context: {},
      query: "already expired",
      limit: 10,
    });
    expect(expiredSearch.results).not.toContainEqual(
      expect.objectContaining({ id: expired.memory.id }),
    );
  });

  it("returns the whole scope while it stays small", async () => {
    const smallScope = new MemoryRepository(pool, bypassOwnerId, {
      maxMemoryContentChars: 12_000,
      maxCheckpointContentChars: 12_000,
      searchBypassMaxScopeSize: 2,
    });
    const repoId = "github.com/example/bypass";
    await smallScope.storeMemory({
      scopeType: "repo",
      context: { repoId },
      kind: "procedure",
      title: "Spark job layout",
      content: "Keep Spark steps in their own module.",
      metadata: {},
      provenance: {},
      confidence: null,
      importance: 0.5,
      expiresAt: null,
    });

    const unrelated = await smallScope.searchMemories({
      scopes: ["repo"],
      context: { repoId },
      query: "DMI-15688 daily stats report",
      limit: 10,
    });
    expect(unrelated.results).toHaveLength(1);
    expect(unrelated.scopeTotal).toBe(1);
    expect(unrelated.matchFilterApplied).toBe(false);

    for (const suffix of ["a", "b"]) {
      await smallScope.storeMemory({
        scopeType: "repo",
        context: { repoId },
        kind: "fact",
        title: `Filler ${suffix}`,
        content: `Unrelated filler memory ${suffix}.`,
        metadata: {},
        provenance: {},
        confidence: null,
        importance: 0.5,
        expiresAt: null,
      });
    }

    const filtered = await smallScope.searchMemories({
      scopes: ["repo"],
      context: { repoId },
      query: "DMI-15688 daily stats report",
      limit: 10,
    });
    expect(filtered.scopeTotal).toBe(3);
    expect(filtered.matchFilterApplied).toBe(true);
    expect(filtered.results).toHaveLength(0);
  });


  it("forgets a memory by owner-scoped ID", async () => {
    const stored = await repository.storeMemory({
      scopeType: "session",
      context: { sessionId: "forget-session" },
      kind: "fact",
      title: "Temporary fact",
      content: "Delete this test memory.",
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
