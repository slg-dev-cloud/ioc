import { hash } from "@node-rs/argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const PASSWORD = "correct horse battery staple";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    passwordHash: await hash(PASSWORD),
    sessionSecret: "test-secret-that-is-at-least-32-characters-long",
    secureCookie: false,
  });
});
afterAll(() => app.close());

const login = (password: string, ip = "10.0.0.1") =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { password }, remoteAddress: ip });

describe("single-owner auth", () => {
  it("rejects API calls without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });

  it("rejects a wrong password", async () => {
    const res = await login("wrong password", "10.0.0.2");
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("logs in with the right password and the cookie opens protected routes", async () => {
    const res = await login(PASSWORD, "10.0.0.3");
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "ioc_session");
    expect(cookie?.httpOnly).toBe(true);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { ioc_session: cookie!.value } });
    expect(me.statusCode).toBe(200);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { ioc_session: cookie!.value } });
    expect(out.statusCode).toBe(200);
  });

  it("rejects a forged cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { ioc_session: "forged" } });
    expect(res.statusCode).toBe(401);
  });

  it("rate-limits login attempts per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await login("nope", "10.0.0.9")).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});
