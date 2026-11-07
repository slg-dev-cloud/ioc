// Runs a connector's fetch() offline and returns what it yielded.
import { connectors } from "../../src/connectors/index.js";
import { HttpClient } from "../../src/connectors/http.js";
import type { RawItem, RunContext, Source } from "../../src/connectors/types.js";
import { fakeFetch, noSleep, type Route } from "./fake-fetch.js";

export function fixtureSource(type: Source["connectorType"], config: Record<string, unknown>): Source {
  return {
    id: "00000000-0000-0000-0000-000000000000", key: `fixture-${type}`, name: "Fixture source", connectorType: type,
    accessMethod: "public_api", tracks: ["signals"], isPrimary: true, priority: "normal",
    config: { rate_limit_per_min: 6000, ...config }, cadenceMinutes: 60, enabled: true, termsNotes: null,
    currentStatus: "active", createdAt: new Date(),
  };
}

export async function runFetch(src: Source, routes: Route[], opts: { since?: Date; now?: Date; watermark?: Record<string, unknown> } = {}) {
  const f = fakeFetch(routes);
  const patch: Record<string, unknown> = {};
  const ctx: RunContext = {
    http: new HttpClient({ fetchImpl: f, sleep: noSleep }),
    now: opts.now ?? new Date("2026-11-07T06:00:00Z"),
    watermark: opts.watermark ?? {},
    setWatermark: (p) => Object.assign(patch, p),
    log: () => {},
  };
  const connector = connectors[src.connectorType];
  const items: RawItem[] = [];
  for await (const r of connector.fetch(src, opts.since ?? new Date("2026-11-05T00:00:00Z"), ctx)) items.push(r);
  return { items, patch, calls: f.calls, connector, normalize: (i: RawItem) => connector.normalize(i, src) };
}
