import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp/server.js";
import { MemoryRepository } from "./db/repository.js";

type SessionState = {
  transport: StreamableHTTPServerTransport;
  closeServer: () => Promise<void>;
};

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  if (response.headersSent) {
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 2_000_000) {
      throw new Error("MCP request body too large");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function authorized(request: IncomingMessage, apiKey?: string): boolean {
  if (!apiKey) {
    return true;
  }
  const authorization = headerValue(request, "authorization");
  const headerKey = headerValue(request, "x-memory-api-key");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : headerKey;
  if (!provided) {
    return false;
  }
  const expectedBuffer = Buffer.from(apiKey);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function sessionId(request: IncomingMessage): string | undefined {
  return headerValue(request, "mcp-session-id");
}

export function createHttpServer(
  repository: MemoryRepository,
  config: Config,
  healthCheck: () => Promise<void>,
): {
  server: ReturnType<typeof createServer>;
  closeSessions: () => Promise<void>;
} {
  const sessions = new Map<string, SessionState>();

  const handleMcp = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!authorized(request, config.apiKey)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const method = request.method ?? "GET";
    const currentSessionId = sessionId(request);

    if (method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error: unknown) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid JSON body",
        });
        return;
      }

      let state: SessionState | undefined = currentSessionId
        ? sessions.get(currentSessionId)
        : undefined;

      if (!state && !currentSessionId && isInitializeRequest(body)) {
        let transport!: StreamableHTTPServerTransport;
        let closeServer!: () => Promise<void>;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            sessions.set(initializedSessionId, { transport, closeServer });
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
          },
        });
        const mcpServer = createMcpServer(repository, {
          getMcpSessionId: () => transport.sessionId,
        });
        closeServer = async () => {
          await transport.close();
          await mcpServer.close();
        };
        transport.onclose = () => {
          const initializedSessionId = transport.sessionId;
          if (initializedSessionId) {
            sessions.delete(initializedSessionId);
          }
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
        return;
      }

      if (!state) {
        writeJson(response, 400, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: valid MCP session ID required",
          },
          id: null,
        });
        return;
      }

      await state.transport.handleRequest(request, response, body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      if (!currentSessionId) {
        writeJson(response, 400, { error: "MCP session ID required" });
        return;
      }
      const state = sessions.get(currentSessionId);
      if (!state) {
        writeJson(response, 404, { error: "MCP session not found" });
        return;
      }
      await state.transport.handleRequest(request, response);
      if (method === "DELETE") {
        await state.closeServer();
        sessions.delete(currentSessionId);
      }
      return;
    }

    response.setHeader("allow", "GET, POST, DELETE");
    writeJson(response, 405, { error: "method not allowed" });
  };

  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    if (url.pathname === "/health" && request.method === "GET") {
      try {
        await healthCheck();
        writeJson(response, 200, { status: "ok", database: "ok" });
      } catch (error: unknown) {
        console.error("Health check failed:", error);
        writeJson(response, 503, {
          status: "degraded",
          database: "unavailable",
        });
      }
      return;
    }

    if (url.pathname === "/mcp") {
      try {
        await handleMcp(request, response);
      } catch (error: unknown) {
        console.error("MCP request failed:", error);
        if (!response.headersSent) {
          writeJson(response, 500, {
            error: "internal server error",
          });
        }
      }
      return;
    }

    writeJson(response, 404, { error: "not found" });
  });

  return {
    server,
    closeSessions: async () => {
      for (const [id, state] of sessions) {
        try {
          await state.closeServer();
        } finally {
          sessions.delete(id);
        }
      }
    },
  };
}
