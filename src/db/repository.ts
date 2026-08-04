import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { redactJson, redactText } from "../security/redact.js";
import {
  hashContent,
  resolveScopeId,
  resolveScopeIds,
  ScopeValidationError,
} from "../security/scope.js";
import type {
  JsonObject,
  LoopCheckpointRecord,
  LoopResumeResult,
  LoopRunRecord,
  LoopStatus,
  MemoryContext,
  MemoryKind,
  MemoryRecord,
  MemorySearchResult,
  ScopeType,
} from "../types.js";

export class RepositoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryValidationError";
  }
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export type MemoryWriteResult = {
  memory: MemoryRecord;
  redacted: boolean;
  redactionReasons: string[];
};

export type StoreMemoryInput = {
  scopeType: ScopeType;
  context: MemoryContext;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  metadata: JsonObject;
  provenance: JsonObject;
  confidence: number | null;
  importance: number;
  expiresAt: string | null;
};

export type UpdateMemoryInput = {
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
  metadata?: JsonObject;
  provenance?: JsonObject;
  confidence?: number | null;
  importance?: number;
  expiresAt?: string | null;
};

export type SearchMemoryInput = {
  scopes: ScopeType[];
  context: MemoryContext;
  query: string;
  kind?: MemoryKind;
  tags?: string[];
  limit: number;
};

export type ListMemoryInput = {
  scopes: ScopeType[];
  context: MemoryContext;
  kind?: MemoryKind;
  limit: number;
};

export type StartLoopInput = {
  sessionId: string;
  repoId: string | null;
  task: string;
};

export type CheckpointLoopInput = {
  runId: string;
  step: number;
  completedSummary: string;
  artifacts: unknown[];
  errors: unknown[];
  state: JsonObject;
  nextAction: string | null;
  idempotencyKey: string;
};

export type FinishLoopInput = {
  runId: string;
  status: Exclude<LoopStatus, "running">;
  currentStep?: number;
};

type Limits = {
  maxMemoryContentChars: number;
  maxCheckpointContentChars: number;
  sessionRetentionDays?: number;
};

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rowToMemory(row: QueryResultRow): MemoryRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    scopeType: row.scope_type as ScopeType,
    scopeId: String(row.scope_id),
    kind: row.kind as MemoryKind,
    title: String(row.title),
    content: String(row.content),
    tags: (row.tags as string[] | null) ?? [],
    metadata: asJsonObject(row.metadata),
    provenance: asJsonObject(row.provenance),
    confidence: row.confidence === null ? null : Number(row.confidence),
    importance: Number(row.importance),
    contentHash: String(row.content_hash),
    embeddingModel: row.embedding_model ? String(row.embedding_model) : null,
    createdAt: asIso(row.created_at) as string,
    updatedAt: asIso(row.updated_at) as string,
    lastAccessedAt: asIso(row.last_accessed_at),
    expiresAt: asIso(row.expires_at),
    archivedAt: asIso(row.archived_at),
  };
}

function rowToSearchResult(row: QueryResultRow): MemorySearchResult {
  return {
    ...rowToMemory(row),
    score: Number(row.score),
    textScore: Number(row.text_score),
    trigramScore: Number(row.trigram_score),
  };
}

function rowToLoopRun(row: QueryResultRow): LoopRunRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    sessionId: String(row.session_id),
    repoId: row.repo_id ? String(row.repo_id) : null,
    task: String(row.task),
    status: row.status as LoopStatus,
    currentStep: Number(row.current_step),
    createdAt: asIso(row.created_at) as string,
    updatedAt: asIso(row.updated_at) as string,
    expiresAt: asIso(row.expires_at),
    completedAt: asIso(row.completed_at),
  };
}

function rowToCheckpoint(row: QueryResultRow): LoopCheckpointRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    step: Number(row.step),
    completedSummary: String(row.completed_summary),
    artifacts: asUnknownArray(row.artifacts),
    errors: asUnknownArray(row.errors),
    state: asJsonObject(row.state),
    nextAction: row.next_action ? String(row.next_action) : null,
    idempotencyKey: String(row.idempotency_key),
    createdAt: asIso(row.created_at) as string,
  };
}

function ensureLength(name: string, value: string, max: number): void {
  if (value.length > max) {
    throw new RepositoryValidationError(
      `${name} exceeds maximum length of ${max} characters`,
    );
  }
}

function ensureProbability(name: string, value: number | null): void {
  if (value !== null && (value < 0 || value > 1)) {
    throw new RepositoryValidationError(`${name} must be between 0 and 1`);
  }
}

function parseExpiry(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RepositoryValidationError("expiresAt must be a valid ISO date");
  }
  return date;
}

function combineRedactions(
  ...results: Array<{ redacted: boolean; reasons: string[] }>
): { redacted: boolean; reasons: string[] } {
  const reasons = new Set<string>();
  let redacted = false;
  for (const result of results) {
    redacted ||= result.redacted;
    result.reasons.forEach((reason) => reasons.add(reason));
  }
  return { redacted, reasons: [...reasons] };
}

export class MemoryRepository {
  private readonly sessionRetentionDays: number;

  constructor(
    private readonly pool: Pool,
    private readonly ownerId: string,
    private readonly limits: Limits,
  ) {
    this.sessionRetentionDays = limits.sessionRetentionDays ?? 2;
    if (
      !Number.isInteger(this.sessionRetentionDays) ||
      this.sessionRetentionDays <= 0
    ) {
      throw new RepositoryValidationError(
        "sessionRetentionDays must be a positive integer",
      );
    }
  }

  async storeMemory(input: StoreMemoryInput): Promise<MemoryWriteResult> {
    const scopeId = this.resolveScope(input.scopeType, input.context);
    const titleResult = redactText(input.title.trim());
    const contentResult = redactText(input.content.trim());
    ensureLength("title", titleResult.value, 500);
    ensureLength(
      "content",
      contentResult.value,
      this.limits.maxMemoryContentChars,
    );
    if (!titleResult.value || !contentResult.value) {
      throw new RepositoryValidationError("title and content are required");
    }

    ensureProbability("confidence", input.confidence);
    ensureProbability("importance", input.importance);
    const tagsResult = input.tags.map((tag) => redactText(tag.trim()));
    const metadataResult = redactJson(input.metadata);
    const provenanceResult = redactJson(input.provenance);
    const redaction = combineRedactions(
      titleResult,
      contentResult,
      ...tagsResult,
      metadataResult,
      provenanceResult,
    );
    const tags = tagsResult
      .map((result) => result.value.trim())
      .filter((tag) => tag.length > 0);
    const metadata = asJsonObject(metadataResult.value);
    const provenance = asJsonObject(provenanceResult.value);
    const expiresAt = this.resolveMemoryExpiry(
      input.scopeType,
      input.expiresAt,
    );
    const contentHash = hashContent(contentResult.value);

    const result = await this.pool.query(
      `
        INSERT INTO memories (
          id, owner_id, scope_type, scope_id, kind, title, content, tags,
          metadata, provenance, confidence, importance, content_hash, expires_at
        )
        VALUES (
          $1, $2, $3::memory_scope, $4, $5::memory_kind, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11, $12, $13, $14
        )
        ON CONFLICT (owner_id, scope_type, scope_id, kind, content_hash)
        DO UPDATE SET
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          provenance = EXCLUDED.provenance,
          confidence = EXCLUDED.confidence,
          importance = EXCLUDED.importance,
          expires_at = EXCLUDED.expires_at,
          archived_at = NULL,
          updated_at = now()
        RETURNING *
      `,
      [
        randomUUID(),
        this.ownerId,
        input.scopeType,
        scopeId,
        input.kind,
        titleResult.value,
        contentResult.value,
        tags,
        JSON.stringify(metadata),
        JSON.stringify(provenance),
        input.confidence,
        input.importance,
        contentHash,
        expiresAt,
      ],
    );

    return {
      memory: rowToMemory(result.rows[0]),
      redacted: redaction.redacted,
      redactionReasons: redaction.reasons,
    };
  }

  async updateMemory(input: UpdateMemoryInput): Promise<MemoryWriteResult> {
    const current = await this.getMemory(input.id);
    if (!current) {
      throw new RepositoryNotFoundError(`memory ${input.id} not found`);
    }

    const titleResult =
      input.title === undefined
        ? { value: current.title, redacted: false, reasons: [] }
        : redactText(input.title.trim());
    const contentResult =
      input.content === undefined
        ? { value: current.content, redacted: false, reasons: [] }
        : redactText(input.content.trim());
    ensureLength("title", titleResult.value, 500);
    ensureLength(
      "content",
      contentResult.value,
      this.limits.maxMemoryContentChars,
    );
    if (!titleResult.value || !contentResult.value) {
      throw new RepositoryValidationError("title and content are required");
    }

    const tagsResults =
      input.tags?.map((tag) => redactText(tag.trim())) ??
      current.tags.map((tag) => ({
        value: tag,
        redacted: false,
        reasons: [] as string[],
      }));
    const metadataResult =
      input.metadata === undefined
        ? { value: current.metadata, redacted: false, reasons: [] }
        : redactJson(input.metadata);
    const provenanceResult =
      input.provenance === undefined
        ? { value: current.provenance, redacted: false, reasons: [] }
        : redactJson(input.provenance);
    const redaction = combineRedactions(
      titleResult,
      contentResult,
      ...tagsResults,
      metadataResult,
      provenanceResult,
    );
    const tags = tagsResults
      .map((result) => result.value.trim())
      .filter((tag) => tag.length > 0);
    const metadata = asJsonObject(metadataResult.value);
    const provenance = asJsonObject(provenanceResult.value);
    const confidence = input.confidence ?? current.confidence;
    const importance = input.importance ?? current.importance;
    ensureProbability("confidence", confidence);
    ensureProbability("importance", importance);
    const expiresAt =
      input.expiresAt === undefined ? current.expiresAt : input.expiresAt;
    const expiryDate = this.resolveMemoryExpiry(current.scopeType, expiresAt);
    const contentHash = hashContent(contentResult.value);

    let result;
    try {
      result = await this.pool.query(
        `
          UPDATE memories
          SET title = $1,
              content = $2,
              tags = $3,
              metadata = $4::jsonb,
              provenance = $5::jsonb,
              confidence = $6,
              importance = $7,
              content_hash = $8,
              expires_at = $9,
              archived_at = NULL,
              updated_at = now()
          WHERE id = $10 AND owner_id = $11
          RETURNING *
        `,
        [
          titleResult.value,
          contentResult.value,
          tags,
          JSON.stringify(metadata),
          JSON.stringify(provenance),
          confidence,
          importance,
          contentHash,
          expiryDate,
          input.id,
          this.ownerId,
        ],
      );
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") {
        throw new RepositoryConflictError(
          "another memory already has same scope, kind, and content",
        );
      }
      throw error;
    }

    if (!result.rowCount) {
      throw new RepositoryNotFoundError(`memory ${input.id} not found`);
    }

    return {
      memory: rowToMemory(result.rows[0]),
      redacted: redaction.redacted,
      redactionReasons: redaction.reasons,
    };
  }

  async getMemory(id: string): Promise<MemoryRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM memories WHERE id = $1 AND owner_id = $2",
      [id, this.ownerId],
    );
    return result.rowCount ? rowToMemory(result.rows[0]) : null;
  }

  async forgetMemory(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM memories WHERE id = $1 AND owner_id = $2",
      [id, this.ownerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async archiveMemory(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE memories
        SET archived_at = now(), updated_at = now()
        WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL
      `,
      [id, this.ownerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cleanupExpired(): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM loop_runs
        WHERE owner_id = $1
          AND expires_at IS NOT NULL
          AND expires_at <= now()
      `,
      [this.ownerId],
    );
    await this.pool.query(
      `
        DELETE FROM memories
        WHERE owner_id = $1
          AND expires_at IS NOT NULL
          AND expires_at <= now()
      `,
      [this.ownerId],
    );
  }

  async searchMemories(
    input: SearchMemoryInput,
  ): Promise<MemorySearchResult[]> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }
    const scopes = resolveScopeIds(input.scopes, input.context);
    const values: unknown[] = [this.ownerId];
    const scopeClauses = scopes.map(({ scopeType, scopeId }) => {
      const scopeTypeIndex = values.push(scopeType);
      const scopeIdIndex = values.push(scopeId);
      return `(scope_type = $${scopeTypeIndex}::memory_scope AND scope_id = $${scopeIdIndex})`;
    });
    const queryIndex = values.push(query);
    const where = [
      "owner_id = $1",
      "archived_at IS NULL",
      "(expires_at IS NULL OR expires_at > now())",
      `(${scopeClauses.join(" OR ")})`,
      `(
        search_document @@ websearch_to_tsquery('simple', $${queryIndex}::text)
        OR title % $${queryIndex}::text
        OR content % $${queryIndex}::text
        OR title ILIKE '%' || $${queryIndex}::text || '%'
        OR content ILIKE '%' || $${queryIndex}::text || '%'
      )`,
    ];

    if (input.kind) {
      const kindIndex = values.push(input.kind);
      where.push(`kind = $${kindIndex}::memory_kind`);
    }
    if (input.tags?.length) {
      const tagsIndex = values.push(input.tags);
      where.push(`tags && $${tagsIndex}::text[]`);
    }

    const limitIndex = values.push(input.limit);
    const result = await this.pool.query(
      `
        SELECT *,
          ts_rank_cd(
            search_document,
            websearch_to_tsquery('simple', $${queryIndex}::text)
          ) AS text_score,
          GREATEST(
            similarity(title, $${queryIndex}::text),
            similarity(content, $${queryIndex}::text)
          ) AS trigram_score,
          (
            0.65 * ts_rank_cd(
              search_document,
              websearch_to_tsquery('simple', $${queryIndex}::text)
            )
            + 0.25 * GREATEST(
              similarity(title, $${queryIndex}::text),
              similarity(content, $${queryIndex}::text)
            )
            + 0.05 * importance
            + 0.05 * exp(
              -extract(epoch FROM (now() - updated_at)) / 2592000.0
            )
          ) AS score
        FROM memories
        WHERE ${where.join("\n          AND ")}
        ORDER BY score DESC, updated_at DESC
        LIMIT $${limitIndex}
      `,
      values,
    );

    const memories = result.rows.map(rowToSearchResult);
    if (memories.length) {
      await this.pool.query(
        "UPDATE memories SET last_accessed_at = now() WHERE id = ANY($1::uuid[])",
        [memories.map((memory) => memory.id)],
      );
    }
    return memories;
  }

  async listMemories(input: ListMemoryInput): Promise<MemoryRecord[]> {
    const scopes = resolveScopeIds(input.scopes, input.context);
    const values: unknown[] = [this.ownerId];
    const scopeClauses = scopes.map(({ scopeType, scopeId }) => {
      const scopeTypeIndex = values.push(scopeType);
      const scopeIdIndex = values.push(scopeId);
      return `(scope_type = $${scopeTypeIndex}::memory_scope AND scope_id = $${scopeIdIndex})`;
    });
    const where = [
      "owner_id = $1",
      "archived_at IS NULL",
      "(expires_at IS NULL OR expires_at > now())",
      `(${scopeClauses.join(" OR ")})`,
    ];
    if (input.kind) {
      const kindIndex = values.push(input.kind);
      where.push(`kind = $${kindIndex}::memory_kind`);
    }
    const limitIndex = values.push(input.limit);
    const result = await this.pool.query(
      `
        SELECT *
        FROM memories
        WHERE ${where.join("\n          AND ")}
        ORDER BY updated_at DESC
        LIMIT $${limitIndex}
      `,
      values,
    );
    return result.rows.map(rowToMemory);
  }

  async startLoop(input: StartLoopInput): Promise<LoopRunRecord> {
    const sessionId = input.sessionId.trim();
    const taskResult = redactText(input.task.trim());
    if (!sessionId || !taskResult.value) {
      throw new RepositoryValidationError("sessionId and task are required");
    }
    ensureLength(
      "task",
      taskResult.value,
      this.limits.maxCheckpointContentChars,
    );
    const repoId = input.repoId?.trim() || null;
    const result = await this.pool.query(
      `
        INSERT INTO loop_runs (
          id, owner_id, session_id, repo_id, task, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        randomUUID(),
        this.ownerId,
        sessionId,
        repoId,
        taskResult.value,
        this.retentionDate(),
      ],
    );
    return rowToLoopRun(result.rows[0]);
  }

  async checkpointLoop(input: CheckpointLoopInput): Promise<{
    checkpoint: LoopCheckpointRecord;
    redacted: boolean;
    redactionReasons: string[];
  }> {
    if (!input.idempotencyKey.trim()) {
      throw new RepositoryValidationError("idempotencyKey is required");
    }
    if (!Number.isInteger(input.step) || input.step < 0) {
      throw new RepositoryValidationError(
        "step must be a non-negative integer",
      );
    }

    const summaryResult = redactText(input.completedSummary.trim());
    const nextActionResult = input.nextAction
      ? redactText(input.nextAction.trim())
      : { value: null, redacted: false, reasons: [] as string[] };
    ensureLength(
      "completedSummary",
      summaryResult.value,
      this.limits.maxCheckpointContentChars,
    );
    if (nextActionResult.value) {
      ensureLength(
        "nextAction",
        nextActionResult.value,
        this.limits.maxCheckpointContentChars,
      );
    }
    if (!summaryResult.value) {
      throw new RepositoryValidationError("completedSummary is required");
    }

    const artifactsResult = redactJson(input.artifacts);
    const errorsResult = redactJson(input.errors);
    const stateResult = redactJson(input.state);
    const redaction = combineRedactions(
      summaryResult,
      nextActionResult,
      artifactsResult,
      errorsResult,
      stateResult,
    );
    const serialized = JSON.stringify({
      artifacts: artifactsResult.value,
      errors: errorsResult.value,
      state: stateResult.value,
    });
    ensureLength(
      "checkpoint data",
      serialized,
      this.limits.maxCheckpointContentChars,
    );

    const run = await this.pool.query(
      `
        SELECT id
        FROM loop_runs
        WHERE id = $1
          AND owner_id = $2
          AND (expires_at IS NULL OR expires_at > now())
      `,
      [input.runId, this.ownerId],
    );
    if (!run.rowCount) {
      throw new RepositoryNotFoundError(`loop run ${input.runId} not found`);
    }

    const result = await this.pool.query(
      `
        INSERT INTO loop_checkpoints (
          id, run_id, step, completed_summary, artifacts, errors, state,
          next_action, idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
        ON CONFLICT (run_id, idempotency_key)
        DO UPDATE SET
          step = EXCLUDED.step,
          completed_summary = EXCLUDED.completed_summary,
          artifacts = EXCLUDED.artifacts,
          errors = EXCLUDED.errors,
          state = EXCLUDED.state,
          next_action = EXCLUDED.next_action
        RETURNING *
      `,
      [
        randomUUID(),
        input.runId,
        input.step,
        summaryResult.value,
        JSON.stringify(artifactsResult.value),
        JSON.stringify(errorsResult.value),
        JSON.stringify(stateResult.value),
        nextActionResult.value,
        input.idempotencyKey.trim(),
      ],
    );
    await this.pool.query(
      `
        UPDATE loop_runs
        SET current_step = GREATEST(current_step, $1),
            status = 'running',
            updated_at = now(),
            completed_at = NULL,
            expires_at = $4
        WHERE id = $2 AND owner_id = $3
      `,
      [input.step, input.runId, this.ownerId, this.retentionDate()],
    );

    return {
      checkpoint: rowToCheckpoint(result.rows[0]),
      redacted: redaction.redacted,
      redactionReasons: redaction.reasons,
    };
  }

  async resumeLoop(
    runId: string | null,
    sessionId: string,
    repoId: string | null,
  ): Promise<LoopResumeResult | null> {
    const values: unknown[] = [this.ownerId];
    let where =
      "owner_id = $1 AND status IN ('running', 'paused') " +
      "AND (expires_at IS NULL OR expires_at > now())";
    if (runId) {
      values.push(runId);
      where += ` AND id = $${values.length}`;
      values.push(sessionId.trim());
      where += ` AND session_id = $${values.length}`;
      if (repoId) {
        values.push(repoId.trim());
        where += ` AND repo_id = $${values.length}`;
      }
    } else {
      values.push(sessionId.trim());
      where += ` AND session_id = $${values.length}`;
      if (repoId) {
        values.push(repoId.trim());
        where += ` AND repo_id = $${values.length}`;
      } else {
        where += " AND repo_id IS NULL";
      }
    }

    const runResult = await this.pool.query(
      `
        SELECT *
        FROM loop_runs
        WHERE ${where}
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      values,
    );
    if (!runResult.rowCount) {
      return null;
    }

    const run = rowToLoopRun(runResult.rows[0]);
    const checkpointResult = await this.pool.query(
      `
        SELECT *
        FROM loop_checkpoints
        WHERE run_id = $1
        ORDER BY step DESC, created_at DESC
        LIMIT 1
      `,
      [run.id],
    );
    return {
      run,
      checkpoint: checkpointResult.rowCount
        ? rowToCheckpoint(checkpointResult.rows[0])
        : null,
    };
  }

  async finishLoop(input: FinishLoopInput): Promise<LoopRunRecord> {
    const result = await this.pool.query(
      `
        UPDATE loop_runs
        SET status = $1::loop_status,
            current_step = COALESCE($2, current_step),
            updated_at = now(),
            completed_at = CASE
              WHEN $1::loop_status IN ('completed', 'failed') THEN now()
              ELSE NULL
            END
        WHERE id = $3 AND owner_id = $4
        RETURNING *
      `,
      [input.status, input.currentStep ?? null, input.runId, this.ownerId],
    );
    if (!result.rowCount) {
      throw new RepositoryNotFoundError(`loop run ${input.runId} not found`);
    }
    return rowToLoopRun(result.rows[0]);
  }

  private resolveScope(scopeType: ScopeType, context: MemoryContext): string {
    try {
      return resolveScopeId(scopeType, context);
    } catch (error: unknown) {
      if (error instanceof ScopeValidationError) {
        throw new RepositoryValidationError(error.message);
      }
      throw error;
    }
  }

  private resolveMemoryExpiry(
    scopeType: ScopeType,
    value: string | null,
  ): Date | null {
    const explicit = parseExpiry(value);
    if (scopeType !== "session") {
      return explicit;
    }

    const sessionLimit = this.retentionDate();
    if (!explicit || explicit > sessionLimit) {
      return sessionLimit;
    }
    return explicit;
  }

  private retentionDate(): Date {
    return new Date(
      Date.now() + this.sessionRetentionDays * 24 * 60 * 60 * 1000,
    );
  }
}
