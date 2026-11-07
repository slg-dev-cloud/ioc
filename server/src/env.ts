import { z } from "zod";

// Secrets live only in env vars (CLAUDE.md rule 7). Never log these values.
const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  OWNER_PASSWORD_HASH: z.string().startsWith("$argon2", "must be an argon2 hash (pnpm --filter @ioc/server hash-password)"),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  NODE_ENV: z.string().default("development"),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${problems}`);
  }
  return parsed.data;
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}
