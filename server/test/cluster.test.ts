// Event clustering and significance (M4) with controlled fixture vectors.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../src/db.js";
import { clusterPending, eventStatus, joinableEntities, normalizeEntity, runningMean, significance } from "../src/pipeline/cluster.js";
import { loadConfig, seed } from "../src/seed.js";
import { freshDb, testDbUrl } from "./helpers/db.js";

const DIM = schema.EMBEDDING_DIM;
const W = { importance: 0.45, relevance: 0.35, per_distinct_source: 4, primary_source_bonus: 5, watchlist_bonus: 10, age_penalty_per_hour: 0.3 };

/** Unit vector at axis i, tilted toward axis j so cos(unit(i), vec) = cos. */
function vec(i: number, j?: number, cos = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = cos;
  if (j !== undefined) v[j] = Math.sqrt(1 - cos * cos);
  return v;
}

describe("pure helpers", () => {
  const now = new Date("2026-11-07T00:00:00Z");
  it("computes spec §7.2 significance", () => {
    const s = { maxImportance: 80, maxRelevance: 60, distinctSources: 7, hasPrimarySource: true, watchlistHit: true, lastSeenAt: new Date(now.getTime() - 10 * 3_600_000) };
    // 36 + 21 + 20 (capped at 5 sources) + 5 + 10 - 3
    expect(significance(s, W, now)).toBe(89);
    expect(significance({ ...s, distinctSources: 1, hasPrimarySource: false, watchlistHit: false, lastSeenAt: now }, W, now)).toBe(61);
  });
  it("derives status", () => {
    const base = { distinctSources: 1, hasPrimarySource: false, lastSeenAt: now };
    expect(eventStatus(base, now)).toBe("developing");
    expect(eventStatus({ ...base, distinctSources: 2 }, now)).toBe("confirmed");
    expect(eventStatus({ ...base, hasPrimarySource: true }, now)).toBe("confirmed");
    expect(eventStatus({ ...base, lastSeenAt: new Date(now.getTime() - 8 * 86_400_000) }, now)).toBe("stale");
  });
  it("normalizes entities and ignores locations for joining", () => {
    expect(normalizeEntity("  U.S. Navy ")).toBe("u s navy");
    expect(joinableEntities([{ name: "Japan", type: "location" }, { name: "Plaid", type: "organization" }])).toEqual(new Set(["plaid"]));
  });
  it("updates the centroid as a running mean", () => {
    expect(runningMean([1, 0], 1, [0, 1])).toEqual([0.5, 0.5]);
    expect(runningMean([0.5, 0.5], 2, [1, 0])).toEqual([2 / 3, 1 / 3]);
  });
});

describe.skipIf(!testDbUrl)("clustering (M4)", () => {
  let db: Db;
  let end: () => Promise<void>;
  let primaryId: string;
  let pressId: string;
  let n = 0;
  const T0 = new Date("2026-11-06T00:00:00Z");
  const NOW = new Date("2026-11-06T12:00:00Z");
  const h = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

  beforeAll(async () => {
    ({ db, end } = await freshDb());
    await seed(db, loadConfig());
    const [p] = await db.insert(schema.sources).values({ key: "fixture-primary", name: "Fixture primary source (test only)", connectorType: "federal_register", accessMethod: "public_api", isPrimary: true, tracks: ["fintech_reg"], config: {}, cadenceMinutes: 60 }).returning();
    const [q] = await db.insert(schema.sources).values({ key: "fixture-press", name: "Fixture press source (test only)", connectorType: "rss", accessMethod: "public_feed", tracks: ["ai_tech"], config: {}, cadenceMinutes: 60 }).returning();
    primaryId = p!.id;
    pressId = q!.id;
  });
  afterAll(() => end?.());
  beforeEach(async () => {
    await db.execute(sql`truncate event_evidence, events, evidence_duplicates, evidence_embeddings, classifications cascade`);
  });

  async function item(title: string, v: number[], o: { host?: string; at?: Date; tracks?: string[]; entities?: { name: string; type: string }[]; primary?: boolean; importance?: number; relevance?: number; hits?: string[] } = {}) {
    const id = ++n;
    const [e] = await db.insert(schema.evidenceRecords).values({
      sourceId: o.primary ? primaryId : pressId,
      canonicalUrl: `https://${o.host ?? "a.example.invalid"}/fixture-${id}`,
      title, publishedAt: o.at ?? T0, fingerprint: `fixture-cluster-${id}-${Math.random()}`, collectionMethod: "scheduled",
    }).returning();
    await db.insert(schema.classifications).values({
      evidenceId: e!.id, tracks: o.tracks ?? ["ai_tech"], geography: [], entities: o.entities ?? [], topics: [],
      relevance: o.relevance ?? 60, importance: o.importance ?? 50, isNoise: false, watchlistHits: o.hits ?? [], model: "fixture", promptVersion: "fixture",
    });
    await db.insert(schema.evidenceEmbeddings).values({ evidenceId: e!.id, model: "fixture", embedding: v });
    return e!.id;
  }
  const eventOf = async (evidenceId: string) => (await db.select().from(schema.eventEvidence).where(eq(schema.eventEvidence.evidenceId, evidenceId)))[0]?.eventId;
  const eventRow = async (id: string) => (await db.select().from(schema.events).where(eq(schema.events.id, id)))[0]!;
  const run = (now = NOW) => clusterPending(db, { now });

  it("collapses the same story from two outlets into one confirmed event", async () => {
    const a = await item("Fixture: Outlet A reports policy change", vec(1), { host: "www.outlet-a.example.invalid" });
    const b = await item("Fixture: Outlet B on the same policy change", vec(1, 2, 0.9), { host: "outlet-b.example.invalid", at: h(2) });
    const r = await run();
    expect(r).toMatchObject({ assigned: 2, created: 1, joined: 1 });
    const id = (await eventOf(a))!;
    expect(await eventOf(b)).toBe(id);
    const ev = await eventRow(id);
    expect(ev).toMatchObject({ title: "Fixture: Outlet A reports policy change", distinctSources: 2, status: "confirmed" });
    expect(ev.firstSeenAt.toISOString()).toBe(T0.toISOString());
    expect(ev.lastSeenAt.toISOString()).toBe(h(2).toISOString());
  });

  it("counts www and bare host as one source", async () => {
    const a = await item("Fixture host A", vec(3), { host: "www.same.example.invalid" });
    await item("Fixture host A again", vec(3, 4, 0.95), { host: "same.example.invalid", at: h(1) });
    await run();
    expect((await eventRow((await eventOf(a))!)).distinctSources).toBe(1);
  });

  it("joins between the two thresholds only with a shared non-location entity", async () => {
    const plaid = [{ name: "Plaid", type: "organization" }];
    const a = await item("Fixture anchor", vec(5), { entities: plaid });
    const shared = await item("Fixture related, shares Plaid", vec(5, 6, 0.83), { at: h(1), entities: [{ name: "plaid", type: "organization" }] });
    const placeOnly = await item("Fixture related, shares only Japan", vec(5, 7, 0.83), { at: h(2), entities: [{ name: "Japan", type: "location" }] });
    await db.update(schema.classifications).set({ entities: [...plaid, { name: "Japan", type: "location" }] }).where(eq(schema.classifications.evidenceId, a));
    await run();
    const id = await eventOf(a);
    expect(await eventOf(shared)).toBe(id);
    expect(await eventOf(placeOnly)).not.toBe(id);
  });

  it("creates a new event below the join threshold, without track overlap, or outside 72h", async () => {
    const a = await item("Fixture base", vec(10));
    const far = await item("Fixture different topic", vec(10, 11, 0.7), { at: h(1) });
    const otherTrack = await item("Fixture same vector, other track", vec(10), { at: h(1), tracks: ["economy"] });
    const late = await item("Fixture same vector, 4 days later", vec(10), { at: h(96) });
    await run(h(100));
    const id = await eventOf(a);
    for (const x of [far, otherTrack, late]) expect(await eventOf(x)).not.toBe(id);
    expect(await db.select().from(schema.events)).toHaveLength(4);
  });

  it("confirms an event with a primary source and adds watchlist and source bonuses", async () => {
    const a = await item("Fixture primary notice", vec(12), { primary: true, tracks: ["fintech_reg"], importance: 80, relevance: 60, hits: ["00000000-0000-0000-0000-000000000001"] });
    await run(T0);
    const ev = await eventRow((await eventOf(a))!);
    expect(ev).toMatchObject({ status: "confirmed", hasPrimarySource: true, distinctSources: 1 });
    expect(ev.significance).toBeCloseTo(80 * 0.45 + 60 * 0.35 + 4 + 5 + 10, 2);
  });

  it("skips near-duplicates and never assigns an item twice", async () => {
    const a = await item("Fixture original", vec(14));
    const dup = await item("Fixture syndicated copy", vec(14), { at: h(1) });
    await db.insert(schema.evidenceDuplicates).values({ evidenceId: dup, dupOfId: a, cosine: 0.99 });
    expect((await run()).assigned).toBe(1);
    expect(await eventOf(dup)).toBeUndefined();
    expect((await run()).assigned).toBe(0);
    expect(await db.select().from(schema.eventEvidence)).toHaveLength(1);
  });

  it("marks events stale after 7 days and stops joining them", async () => {
    const a = await item("Fixture old story", vec(16));
    await run(T0);
    await run(h(24 * 8));
    const ev = await eventRow((await eventOf(a))!);
    expect(ev.status).toBe("stale");
    const later = await item("Fixture follow-up much later", vec(16), { at: h(24 * 8) });
    await run(h(24 * 8));
    expect(await eventOf(later)).not.toBe(ev.id);
  });

  it("moves the centroid toward joined items", async () => {
    const a = await item("Fixture centroid A", vec(20));
    await item("Fixture centroid B", vec(20, 21, 0.9), { at: h(1) });
    await run();
    const ev = await eventRow((await eventOf(a))!);
    expect(ev.centroid![20]).toBeCloseTo((1 + 0.9) / 2, 5);
    expect(ev.centroid![21]).toBeCloseTo(Math.sqrt(1 - 0.81) / 2, 5);
  });
});
