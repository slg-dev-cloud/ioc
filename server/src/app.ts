import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import secureSession from "@fastify/secure-session";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import { isAuthenticated, PUBLIC_API_ROUTES, registerAuthRoutes } from "./api/auth.js";
import type { Db } from "./db.js";

declare module "@fastify/secure-session" {
  interface SessionData { owner: boolean }
}

export interface AppOptions {
  passwordHash: string;
  sessionSecret: string;
  secureCookie: boolean;
  db?: Db;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Never log request bodies (passwords) or cookies.
    disableRequestLogging: false,
  });

  await app.register(rateLimit, { global: false });
  await app.register(secureSession, {
    key: createHash("sha256").update(opts.sessionSecret).digest(),
    cookieName: "ioc_session",
    expiry: 60 * 60 * 24 * 14,
    cookie: { path: "/", httpOnly: true, sameSite: "strict", secure: opts.secureCookie },
  });

  // Every /api route requires the session except login (spec §9).
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || PUBLIC_API_ROUTES.has(path)) return;
    if (!isAuthenticated(req)) return reply.code(401).send({ error: "unauthorized" });
  });

  await registerAuthRoutes(app, { passwordHash: opts.passwordHash });

  app.get("/api/status", async () => {
    if (!opts.db) return { db: "not_configured" };
    const res = await opts.db.execute(sql`select extversion from pg_extension where extname = 'vector'`);
    const row = res.rows[0] as { extversion?: string } | undefined;
    return { db: "ok", pgvector: row?.extversion ?? null };
  });

  return app;
}
