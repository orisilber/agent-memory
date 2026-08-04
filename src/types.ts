import { z } from "zod";

export const scopeTypeSchema = z.enum(["global", "repo", "session"]);
export const memoryKindSchema = z.enum([
  "preference",
  "procedure",
  "decision",
  "fact",
]);
export const loopStatusSchema = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
]);

export const memoryContextSchema = z.object({
  sessionId: z.string().trim().min(1).max(256).optional(),
  repoId: z.string().trim().min(1).max(512).optional(),
});

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type ScopeType = z.infer<typeof scopeTypeSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type LoopStatus = z.infer<typeof loopStatusSchema>;
export type MemoryContext = z.infer<typeof memoryContextSchema>;
export type JsonObject = Record<string, unknown>;

export type MemoryRecord = {
  id: string;
  ownerId: string;
  scopeType: ScopeType;
  scopeId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  metadata: JsonObject;
  provenance: JsonObject;
  confidence: number | null;
  importance: number;
  contentHash: string;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
};

export type MemorySearchResult = MemoryRecord & {
  score: number;
  textScore: number;
  trigramScore: number;
};

export type LoopRunRecord = {
  id: string;
  ownerId: string;
  sessionId: string;
  repoId: string | null;
  task: string;
  status: LoopStatus;
  currentStep: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  completedAt: string | null;
};

export type LoopCheckpointRecord = {
  id: string;
  runId: string;
  step: number;
  completedSummary: string;
  artifacts: unknown[];
  errors: unknown[];
  state: JsonObject;
  nextAction: string | null;
  idempotencyKey: string;
  createdAt: string;
};

export type LoopResumeResult = {
  run: LoopRunRecord;
  checkpoint: LoopCheckpointRecord | null;
};
