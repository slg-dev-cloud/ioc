import { describe, expect, it } from "vitest";
import { HttpClient, HttpError, limiterFor, NetworkError, redactUrl, RobotsDisallowedError, USER_AGENT } from "../src/connectors/http.js";
import { parseRobots } from "../src/connectors/robots.js";
import { fakeFetch, noSleep } from "./helpers/fake-fetch.js";

const L = { limiterKey: "k", minIntervalMs: 0 };

describe("robots.txt parsing", () => {
  const txt = `
User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /private/
Allow: /private/ok
Disallow: /*.pdf$
`;
  const r = parseRobots(txt, "IOC");
  it("uses the * group when no group names us", () => {
    expect(r.isAllowed("/feed")).toBe(true);
    expect(r.isAllowed("/private/x")).toBe(false);
  });
  it("longest match wins, and supports * and $", () => {
    expect(r.isAllowed("/private/ok")).toBe(true);
    expect(r.isAllowed("/files/a.pdf")).toBe(false);
    expect(r.isAllowed("/files/a.pdf?x=1")).toBe(true);
  });
  it("uses a group that names our token over *", () => {
    expect(parseRobots("User-agent: IOC\nDisallow: /\n\nUser-agent: *\nDisallow:", "IOC").isAllowed("/feed")).toBe(false);
  });
});

describe("HttpClient", () => {
  it("sends an honest user agent", async () => {
    const f = fakeFetch([["https://a.test/x", { body: "ok" }]]);
    await new HttpClient({ fetchImpl: f, sleep: noSleep }).get("https://a.test/x", L);
    expect(f.calls.at(-1)!.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("retries 429/5xx with backoff, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const f = fakeFetch([["https://a.test/x", () => (++n <= 2 ? { status: n === 1 ? 429 : 503 } : { body: "ok" })]]);
    const res = await new HttpClient({ fetchImpl: f, sleep: async (ms) => { waits.push(ms); }, backoffBaseMs: 100 }).get("https://a.test/x", L);
    expect(res.status).toBe(200);
    expect(waits).toEqual([100, 200]);
  });

  it("gives up after 3 retries with the last status", async () => {
    const f = fakeFetch([["https://a.test/x", { status: 429 }]]);
    const err = await new HttpClient({ fetchImpl: f, sleep: noSleep }).get("https://a.test/x", L).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect(f.calls.filter((c) => c.url === "https://a.test/x")).toHaveLength(4);
  });

  it("does not retry auth failures", async () => {
    const f = fakeFetch([["https://a.test/x", { status: 403 }]]);
    const err = await new HttpClient({ fetchImpl: f, sleep: noSleep }).get("https://a.test/x", L).catch((e) => e);
    expect((err as HttpError).status).toBe(403);
    expect(f.calls.filter((c) => c.url === "https://a.test/x")).toHaveLength(1);
  });

  it("refuses URLs robots.txt disallows, without requesting them", async () => {
    const f = fakeFetch([["https://a.test/robots.txt", { body: "User-agent: *\nDisallow: /feed" }]]);
    const err = await new HttpClient({ fetchImpl: f, sleep: noSleep }).get("https://a.test/feed", L).catch((e) => e);
    expect(err).toBeInstanceOf(RobotsDisallowedError);
    expect(f.calls.map((c) => c.url)).toEqual(["https://a.test/robots.txt"]);
  });

  it("treats a 5xx robots.txt as a temporary network failure, not a disallow", async () => {
    const f = fakeFetch([["https://a.test/robots.txt", { status: 503 }]]);
    const err = await new HttpClient({ fetchImpl: f, sleep: noSleep }).get("https://a.test/feed", L).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });

  it("spaces requests that share a limiter key", async () => {
    let clock = 0;
    const waits: number[] = [];
    const f = fakeFetch([["https://a.test/", { body: "ok" }]]);
    const http = new HttpClient({ fetchImpl: f, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    const opts = { limiterKey: "gdelt", minIntervalMs: 6000 };
    await http.get("https://a.test/1", opts);
    await http.get("https://a.test/2", opts);
    await http.get("https://a.test/3", opts);
    expect(waits).toEqual([6000, 6000]);
  });

  it("derives spacing from rate_limit_per_min, min_interval_ms, and rate_limit_group", () => {
    expect(limiterFor({ rate_limit_per_min: 10 }, "s")).toEqual({ limiterKey: "s", minIntervalMs: 6000 });
    expect(limiterFor({ rate_limit_per_min: 60, min_interval_ms: 6000, rate_limit_group: "gdelt" }, "s"))
      .toEqual({ limiterKey: "gdelt", minIntervalMs: 6000 });
  });

  it("redacts API keys from URLs in errors", () => {
    expect(redactUrl("https://api.sam.gov/x?limit=1&api_key=SECRET123&a=b")).toBe("https://api.sam.gov/x?limit=1&api_key=[redacted]&a=b");
    expect(new HttpError(500, "https://h.test/?api_key=SECRET").message).not.toContain("SECRET");
  });
});
