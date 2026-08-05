import { createHash } from "node:crypto";
import type { MemoryContext, ScopeType } from "../types.js";

export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeValidationError";
  }
}

export function normalizeContentForHash(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function hashContent(content: string): string {
  return createHash("sha256")
    .update(normalizeContentForHash(content))
    .digest("hex");
}

export function normalizeRepoId(repoId: string): string {
  return repoId.trim().replace(/\/+$/u, "");
}

export function resolveScopeId(
  scopeType: ScopeType,
  context: MemoryContext,
): string {
  if (scopeType === "global") {
    return "global";
  }

  if (scopeType === "repo") {
    if (!context.repoId) {
      throw new ScopeValidationError("repo scope requires repoId");
    }
    return normalizeRepoId(context.repoId);
  }

  if (!context.sessionId) {
    throw new ScopeValidationError(
      "session scope requires sessionId (pass sessionId, or call tools over an active MCP session so the transport session can be used)",
    );
  }
  return context.sessionId;
}

export function resolveScopeIds(
  scopeTypes: ScopeType[],
  context: MemoryContext,
): Array<{ scopeType: ScopeType; scopeId: string }> {
  return scopeTypes.map((scopeType) => ({
    scopeType,
    scopeId: resolveScopeId(scopeType, context),
  }));
}
