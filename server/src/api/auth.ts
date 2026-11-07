import type { FastifyInstance, FastifyRequest } from "fastify";
import { verify } from "@node-rs/argon2";
import { z } from "zod";

const LoginBody = z.object({ password: z.string().min(1).max(1024) });

export const PUBLIC_API_ROUTES = new Set(["/api/auth/login"]);

export function isAuthenticated(req: FastifyRequest): boolean {
  return req.session.get("owner") === true;
}

// Single-owner auth: password checked against the argon2 hash in env, then a
// signed, encrypted session cookie. Login attempts are rate-limited per IP.
export async function registerAuthRoutes(app: FastifyInstance, opts: { passwordHash: string }) {
  app.post("/api/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const ok = await verify(opts.passwordHash, body.data.password).catch(() => false);
    if (!ok) {
      req.log.warn({ ip: req.ip }, "failed login");
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    req.session.set("owner", true);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req) => {
    req.session.delete();
    return { ok: true };
  });

  app.get("/api/auth/me", async () => ({ owner: true }));
}
