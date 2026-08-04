import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  MemoryRepository,
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryValidationError,
} from "../db/repository.js";
import {
  jsonObjectSchema,
  memoryKindSchema,
  scopeTypeSchema,
} from "../types.js";
import type { UsageMetric } from "../types.js";

const contextShape = {
  sessionId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe("Current conversation/session identifier"),
  repoId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .optional()
    .describe("Canonical git remote or repository-root fallback"),
};

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown memory service error";
  const errorType =
    error instanceof RepositoryValidationError
      ? "validation_error"
      : error instanceof RepositoryNotFoundError
        ? "not_found"
        : error instanceof RepositoryConflictError
          ? "conflict"
          : "service_error";

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: errorType, message }),
      },
    ],
  };
}

async function trackUsage(
  repository: MemoryRepository,
  metric: UsageMetric,
  amount = 1,
): Promise<void> {
  try {
    await repository.incrementUsage(metric, amount);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown usage tracking error";
    console.error(`Usage tracking failed for ${metric}: ${message}`);
  }
}

export function createMcpServer(repository: MemoryRepository): McpServer {
  const server = new McpServer({
    name: "agent-memory",
    version: "0.1.0",
  });

  server.registerTool(
    "memory_session_start",
    {
      title: "Start memory session",
      description:
        "Create a stable session identifier for this conversation. Keep returned sessionId in agent context and pass it to session-scoped memory and loop tools. Session memories and loop state expire after the configured retention period (2 days by default).",
      inputSchema: {
        repoId: contextShape.repoId,
      },
    },
    async ({ repoId }) =>
      textResult({
        sessionId: randomUUID(),
        repoId: repoId ?? null,
        startedAt: new Date().toISOString(),
      }),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memories",
      description:
        "Search explicit memory scopes for preferences, procedures, decisions, or facts. Choose scopes deliberately; repo scope needs repoId, session scope needs sessionId. Search never broadens scope silently.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        scopes: z
          .array(scopeTypeSchema)
          .min(1)
          .describe("Scopes to search: global, repo, session"),
        ...contextShape,
        kind: memoryKindSchema.optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        limit: z.number().int().min(1).max(100).default(10),
      },
    },
    async ({ query, scopes, sessionId, repoId, kind, tags, limit }) => {
      try {
        const results = await repository.searchMemories({
          query,
          scopes,
          context: { sessionId, repoId },
          ...(kind ? { kind } : {}),
          ...(tags ? { tags } : {}),
          limit,
        });
        return textResult({
          query,
          scopes,
          count: results.length,
          results,
        });
      } catch (error: unknown) {
        await trackUsage(repository, "search_failed");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_store",
    {
      title: "Store memory",
      description:
        "Store an explicit preference, stable procedure, decision, or fact. Search first and choose one scope. Service redacts detected secrets; do not store credentials, tokens, raw logs, or transient chatter.",
      inputSchema: {
        scope: scopeTypeSchema,
        ...contextShape,
        kind: memoryKindSchema,
        title: z.string().trim().min(1).max(500),
        content: z.string().trim().min(1).max(50_000),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
        metadata: jsonObjectSchema.default({}),
        provenance: jsonObjectSchema.default({}),
        confidence: z.number().min(0).max(1).nullable().default(null),
        importance: z.number().min(0).max(1).default(0.5),
        expiresAt: z.string().datetime().nullable().default(null),
      },
    },
    async ({
      scope,
      sessionId,
      repoId,
      kind,
      title,
      content,
      tags,
      metadata,
      provenance,
      confidence,
      importance,
      expiresAt,
    }) => {
      try {
        const result = await repository.storeMemory({
          scopeType: scope,
          context: { sessionId, repoId },
          kind,
          title,
          content,
          tags,
          metadata,
          provenance,
          confidence,
          importance,
          expiresAt,
        });
        return textResult({
          memory: result.memory,
          redacted: result.redacted,
          redactionReasons: result.redactionReasons,
        });
      } catch (error: unknown) {
        await trackUsage(repository, "store_failed");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update memory",
      description:
        "Update one memory by ID after explicit correction or confirmation. Scope and kind stay fixed. Detected secrets are redacted.",
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(500).optional(),
        content: z.string().trim().min(1).max(50_000).optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        metadata: jsonObjectSchema.optional(),
        provenance: jsonObjectSchema.optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        importance: z.number().min(0).max(1).optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      },
    },
    async (input) => {
      try {
        const result = await repository.updateMemory(input);
        return textResult({
          memory: result.memory,
          redacted: result.redacted,
          redactionReasons: result.redactionReasons,
        });
      } catch (error: unknown) {
        await trackUsage(repository, "update_failed");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Forget memory",
      description:
        "Permanently delete one memory by ID. Use only after explicit user request. Confirm ID before calling.",
      inputSchema: {
        id: z.string().uuid(),
        confirm: z
          .literal(true)
          .describe("Must be true for permanent deletion"),
      },
    },
    async ({ id }) => {
      try {
        const deleted = await repository.forgetMemory(id);
        return textResult({ id, deleted });
      } catch (error: unknown) {
        await trackUsage(repository, "forget_failed");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_archive",
    {
      title: "Archive memory",
      description:
        "Hide one memory from normal search without deleting it. Use only after explicit user request. Confirm ID before calling.",
      inputSchema: {
        id: z.string().uuid(),
        confirm: z.literal(true).describe("Must be true to archive memory"),
      },
    },
    async ({ id }) => {
      try {
        const archived = await repository.archiveMemory(id);
        return textResult({ id, archived });
      } catch (error: unknown) {
        await trackUsage(repository, "archive_failed");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memories",
      description:
        "List active memories in explicit scopes for review or export. Choose scopes deliberately; repo scope needs repoId, session scope needs sessionId.",
      inputSchema: {
        scopes: z.array(scopeTypeSchema).min(1),
        ...contextShape,
        kind: memoryKindSchema.optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ scopes, sessionId, repoId, kind, limit }) => {
      try {
        const memories = await repository.listMemories({
          scopes,
          context: { sessionId, repoId },
          ...(kind ? { kind } : {}),
          limit,
        });
        return textResult({ scopes, count: memories.length, memories });
      } catch (error: unknown) {
        await trackUsage(repository, "list_failed");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "loop_start",
    {
      title: "Start memory loop",
      description:
        "Start durable loop state for a task. Call before repeated or retryable work; keep sessionId stable for resume.",
      inputSchema: {
        sessionId: z.string().trim().min(1).max(256),
        repoId: contextShape.repoId,
        task: z.string().trim().min(1).max(50_000),
      },
    },
    async ({ sessionId, repoId, task }) => {
      try {
        const run = await repository.startLoop({
          sessionId,
          repoId: repoId ?? null,
          task,
        });
        return textResult({ run });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "loop_checkpoint",
    {
      title: "Save loop checkpoint",
      description:
        "Save concise completed work, state, errors, artifacts, and next action. Call after meaningful work and before risky retryable side effects. Reuse idempotencyKey on retry.",
      inputSchema: {
        runId: z.string().uuid(),
        step: z.number().int().min(0),
        completedSummary: z.string().trim().min(1).max(50_000),
        artifacts: z.array(z.unknown()).default([]),
        errors: z.array(z.unknown()).default([]),
        state: jsonObjectSchema.default({}),
        nextAction: z.string().trim().max(50_000).nullable().default(null),
        idempotencyKey: z.string().trim().min(1).max(256),
      },
    },
    async (input) => {
      try {
        const result = await repository.checkpointLoop(input);
        return textResult({
          checkpoint: result.checkpoint,
          redacted: result.redacted,
          redactionReasons: result.redactionReasons,
        });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "loop_resume",
    {
      title: "Resume memory loop",
      description:
        "Load latest active loop and checkpoint. Verify current state before repeating any side effect. Pass runId for exact resume, or sessionId plus repoId for latest matching run.",
      inputSchema: {
        runId: z.string().uuid().optional(),
        sessionId: z.string().trim().min(1).max(256),
        repoId: contextShape.repoId,
      },
    },
    async ({ runId, sessionId, repoId }) => {
      try {
        const result = await repository.resumeLoop(
          runId ?? null,
          sessionId,
          repoId ?? null,
        );
        return textResult({ found: Boolean(result), ...result });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "loop_finish",
    {
      title: "Finish memory loop",
      description:
        "Mark loop paused, completed, or failed after recording final checkpoint when useful.",
      inputSchema: {
        runId: z.string().uuid(),
        status: z
          .enum(["paused", "completed", "failed"])
          .describe("Final loop status"),
        currentStep: z.number().int().min(0).optional(),
      },
    },
    async ({ runId, status, currentStep }) => {
      try {
        const run = await repository.finishLoop({
          runId,
          status,
          ...(currentStep === undefined ? {} : { currentStep }),
        });
        return textResult({ run });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  return server;
}
