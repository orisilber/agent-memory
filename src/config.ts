import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://memory:memory@localhost:5433/agent_memory"),
  MEMORY_OWNER_ID: z.string().trim().min(1).default("local-user"),
  MEMORY_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  MAX_MEMORY_CONTENT_CHARS: z.coerce.number().int().positive().default(12_000),
  MAX_CHECKPOINT_CONTENT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  databaseUrl: string;
  ownerId: string;
  apiKey?: string;
  maxMemoryContentChars: number;
  maxCheckpointContentChars: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    databaseUrl: parsed.DATABASE_URL,
    ownerId: parsed.MEMORY_OWNER_ID,
    ...(parsed.MEMORY_API_KEY ? { apiKey: parsed.MEMORY_API_KEY } : {}),
    maxMemoryContentChars: parsed.MAX_MEMORY_CONTENT_CHARS,
    maxCheckpointContentChars: parsed.MAX_CHECKPOINT_CONTENT_CHARS,
  };
}
