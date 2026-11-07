// Connector runner against a real test database with offline fetch.
// M1 acceptance: runs complete, connector_runs are accurate, dedupe holds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../src/db.js";
import { HttpClient } from "../src/connectors/http.js";
import { runSource, SourceNotRunnableError } from "../src/connectors/runner.js";
import { freshDb, testDbUrl } from "./helpers/db.js";
import { fakeFetch, fixture, noSleep, type Route } from "./helpers/fake-fetch.js";

const NOW = new Date("2026-11-07T06:00:00Z");
const FEED = "https://feeds.fixture.test/feed.xml";

describe.skipIf(!testDbUrl)("connector runner (M1)", () => {
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => ({ db, end } = await freshDb()));
  afterAll(() => end?.());
  beforeEach(async () => {
    await db.execute(sql`truncate connector_runs, source_state, evidence_raw restart identity cascade`);
    // evidence_records is append-only even for tests; use fresh source keys per test instead.
  });

  let n = 0;
  async function addSource(config: Record<string, unknown>, enabled = true) {
    const key = `fixture-source-${++n}`;
    await db.insert(schema.sources).values({
      key, name: "Fixture source (test only)", connectorType: "rss", accessMethod: "public_feed",
      tracks: ["ai_tech"], config: { rate_limit_per_min: 600, ...config }, cadenceMinutes: 60, enabled,
    });
    return key;
  }
  const http = (routes: Route[]) => new HttpClient({ fetchImpl: fakeFetch(routes), sleep: noSleep });
  const run = (key: string, routes: Route[], now = NOW) => runSource(db, key, { http: http(routes), now: () => now });
  const runsFor = async (key: string) => db.select().from(schema.connectorRuns)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.connectorRuns.sourceId)).where(eq(schema.sources.key, key));
  const sourceRow = async (key: string) => (await db.select().from(schema.sources).where(eq(schema.sources.key, key)))[0]!;
  const stateOf = async (key: string) => (await db.select().from(schema.sourceState).where(eq(schema.sourceState.sourceId, (await sourceRow(key)).id)))[0];

  it("collects, records the run accurately, and dedupes on a repeated run", async () => {
    const key = await addSource({ url: FEED, initial_lookback_hours: 48 });
    const routes: Route[] = [[FEED, { body: fixture("rss/synthetic-fulltext.xml") }]];

    const first = await run(key, routes);
    expect(first).toMatchObject({ status: "active", itemsFetched: 3, itemsNew: 1, itemsSkippedOld: 1, itemsInvalid: 1, error: null });

    const second = await run(key, routes);
    expect(second).toMatchObject({ status: "active", itemsFetched: 3, itemsNew: 0 });

    const runs = await runsFor(key);
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r.connector_runs.finishedAt).not.toBeNull();
      expect(r.connector_runs.status).toBe("active");
    }
    expect(runs.map((r) => r.connector_runs.itemsNew).sort()).toEqual([0, 1]);

    const src = await sourceRow(key);
    const evidence = await db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.sourceId, src.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.canonicalUrl).toBe("https://fixture.example.invalid/one?id=7");
    expect(evidence[0]!.collectionMethod).toBe("scheduled");
    const raw = await db.select().from(schema.evidenceRaw).where(eq(schema.evidenceRaw.evidenceId, evidence[0]!.id));
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw[0]!.raw)).not.toContain("FULL ARTICLE BODY");

    expect(src.currentStatus).toBe("active");
    expect((await stateOf(key))!.watermark).toMatchObject({ lastSeen: "2026-11-06T12:00:00.000Z" });
  });

  it("dedupes the same URL arriving from a second source", async () => {
    const a = await addSource({ url: FEED });
    const b = await addSource({ url: "https://other.fixture.test/feed.xml" });
    await run(a, [[FEED, { body: fixture("rss/synthetic-atom.xml") }]]);
    const res = await run(b, [["https://other.fixture.test/feed.xml", { body: fixture("rss/synthetic-atom.xml") }]]);
    expect(res).toMatchObject({ status: "active", itemsFetched: 1, itemsNew: 0 });
  });

  it("marks 401/403 as auth_required and does not advance the watermark", async () => {
    const key = await addSource({ url: FEED });
    await db.insert(schema.sourceState).values({ sourceId: (await sourceRow(key)).id, watermark: { lastSeen: "2026-11-06T00:00:00.000Z" } });
    const res = await run(key, [[FEED, { status: 403 }]]);
    expect(res).toMatchObject({ status: "auth_required", sourceStatus: "auth_required", itemsNew: 0 });
    const [r] = await runsFor(key);
    expect(r!.connector_runs).toMatchObject({ status: "auth_required" });
    expect(r!.connector_runs.finishedAt).not.toBeNull();
    expect(r!.connector_runs.error).toMatch(/HTTP 403/);
    expect((await stateOf(key))!.watermark).toEqual({ lastSeen: "2026-11-06T00:00:00.000Z" });
  });

  it("marks exhausted 429 retries as rate_limited", async () => {
    const key = await addSource({ url: FEED });
    expect((await run(key, [[FEED, { status: 429 }]])).status).toBe("rate_limited");
    expect((await sourceRow(key)).currentStatus).toBe("rate_limited");
  });

  it("goes limited, limited, then unavailable after 3 consecutive failures, and recovers", async () => {
    const key = await addSource({ url: FEED });
    const broken: Route[] = [[FEED, { status: 500 }]];
    expect((await run(key, broken)).sourceStatus).toBe("limited");
    expect((await run(key, broken)).sourceStatus).toBe("limited");
    expect((await run(key, broken)).sourceStatus).toBe("unavailable");
    expect((await stateOf(key))!.consecutiveFailures).toBe(3);
    const ok = await run(key, [[FEED, { body: fixture("rss/synthetic-atom.xml") }]]);
    expect(ok.sourceStatus).toBe("active");
    expect((await stateOf(key))!.consecutiveFailures).toBe(0);
  });

  it("marks a robots.txt disallow as unsupported without fetching the feed", async () => {
    const key = await addSource({ url: FEED });
    const f = fakeFetch([["https://feeds.fixture.test/robots.txt", { body: "User-agent: *\nDisallow: /" }]]);
    const res = await runSource(db, key, { http: new HttpClient({ fetchImpl: f, sleep: noSleep }), now: () => NOW });
    expect(res.status).toBe("unsupported");
    expect(f.calls.map((c) => c.url)).not.toContain(FEED);
  });

  it("keeps evidence collected before a mid-run failure, with accurate counts", async () => {
    const key = await addSource({ url: FEED, endpoint: "https://fr.fixture.test/docs.json", agencies: ["x"] });
    await db.update(schema.sources).set({ connectorType: "federal_register" }).where(eq(schema.sources.key, key));
    const page1 = { body: JSON.stringify({ results: [{ title: "Fixture doc", html_url: "https://fr.fixture.test/d/1", publication_date: "2026-11-06" }], next_page_url: "https://fr.fixture.test/p2" }) };
    const res = await run(key, [["https://fr.fixture.test/docs.json", page1], ["https://fr.fixture.test/p2", { status: 404 }]]);
    expect(res).toMatchObject({ status: "unavailable", itemsFetched: 1, itemsNew: 1 });
    const [r] = await runsFor(key);
    expect(r!.connector_runs.itemsNew).toBe(1);
  });

  it("refuses disabled sources and unbuilt connectors without writing a run", async () => {
    const key = await addSource({ url: FEED }, false);
    await expect(run(key, [])).rejects.toBeInstanceOf(SourceNotRunnableError);
    const kev = await addSource({});
    await db.update(schema.sources).set({ connectorType: "cisa_kev" }).where(eq(schema.sources.key, kev));
    await expect(run(kev, [])).rejects.toThrow(/M2/);
    expect(await runsFor(key)).toHaveLength(0);
    expect(await runsFor(kev)).toHaveLength(0);
  });

  it("never stores API keys in run errors", async () => {
    const key = await addSource({ url: "https://feeds.fixture.test/feed.xml?api_key=SECRET-KEY-123" });
    const res = await run(key, [["https://feeds.fixture.test/feed.xml", { status: 500 }]]);
    expect(res.error).not.toContain("SECRET-KEY-123");
    const [r] = await runsFor(key);
    expect(r!.connector_runs.error).not.toContain("SECRET-KEY-123");
  });
});
