// Offline stand-in for fetch. Routes are matched by URL prefix, in order.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../../src/connectors/http.js";

export const fixture = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url)), "utf8");

export interface FakeResponse { status?: number; body?: string; headers?: Record<string, string> }
export type Route = [prefix: string, respond: FakeResponse | ((url: string, init: RequestInit) => FakeResponse)];

export function fakeFetch(routes: Route[]): FetchLike & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    // Default: no robots.txt (404 = no restrictions); anything else unmatched is a test bug.
    const spec = route
      ? (typeof route[1] === "function" ? route[1](url, init) : route[1])
      : url.endsWith("/robots.txt") ? { status: 404, body: "" } : { status: 599, body: `no fake route for ${url}` };
    return new Response(spec.status === 304 ? null : (spec.body ?? ""), { status: spec.status ?? 200, headers: spec.headers });
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => {};
