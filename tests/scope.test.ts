import { describe, expect, it } from "vitest";
import {
  hashContent,
  normalizeContentForHash,
  resolveScopeId,
  ScopeValidationError,
} from "../src/security/scope.js";

describe("scope resolution", () => {
  it("uses stable IDs for global, repo, and session scopes", () => {
    const context = {
      repoId: "https://github.com/example/project/",
      sessionId: "session-123",
    };

    expect(resolveScopeId("global", context)).toBe("global");
    expect(resolveScopeId("repo", context)).toBe(
      "https://github.com/example/project",
    );
    expect(resolveScopeId("session", context)).toBe("session-123");
  });

  it("rejects missing scoped context", () => {
    expect(() => resolveScopeId("repo", {})).toThrow(ScopeValidationError);
    expect(() => resolveScopeId("session", {})).toThrow(
      /session scope requires sessionId/,
    );
  });
});

describe("memory context resolution", () => {
  it("prefers explicit sessionId over MCP transport session", async () => {
    const { resolveMemoryContext } = await import("../src/mcp/server.js");
    expect(
      resolveMemoryContext(
        { sessionId: "explicit", repoId: "repo" },
        () => "mcp-session",
      ),
    ).toEqual({ sessionId: "explicit", repoId: "repo" });
  });

  it("falls back to MCP transport session when sessionId omitted", async () => {
    const { resolveMemoryContext } = await import("../src/mcp/server.js");
    expect(resolveMemoryContext({}, () => "mcp-session")).toEqual({
      sessionId: "mcp-session",
    });
  });
});

describe("memory hashing", () => {
  it("ignores whitespace differences but keeps content meaningful", () => {
    expect(normalizeContentForHash("  use   pnpm\n")).toBe("use pnpm");
    expect(hashContent("use pnpm")).toBe(hashContent(" use   pnpm "));
  });
});
