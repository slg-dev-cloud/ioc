// Integration tests against a real Postgres + pgvector. Skipped when
// TEST_DATABASE_URL is unset. The test database is wiped on every run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../src/db.js";
import { loadConfig, seed } from "../src/seed.js";
import { freshDb, testDbUrl } from "./helpers/db.js";

const url = testDbUrl;

// Drizzle wraps driver errors; the Postgres message is on `cause`.
async function expectPgError(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as Error & { cause?: Error });
  expect(err, "expected the query to fail").not.toBeNull();
  expect(`${err!.message}\n${err!.cause?.message ?? ""}`).toMatch(pattern);
}

describe.skipIf(!url)("database (M0)", () => {
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    ({ db, end } = await freshDb());
  });
  afterAll(() => end?.());

  it("has pgvector and every spec table", async () => {
    const ext = await db.execute(sql`select 1 from pg_extension where extname = 'vector'`);
    expect(ext.rows).toHaveLength(1);
    const res = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const names = new Set(res.rows.map((r) => (r as { table_name: string }).table_name));
    for (const t of [
      "sources", "source_state", "connector_runs", "evidence_records", "evidence_raw",
      "evidence_embeddings", "evidence_duplicates", "classifications", "events", "event_evidence",
      "briefings", "findings", "finding_evidence", "tracks", "watchlist_entities", "settings",
      "feedback", "llm_calls", "audit_events",
    ]) expect(names, t).toContain(t);
  });

  it("has HNSW cosine indexes on embeddings and event centroids", async () => {
    const res = await db.execute(sql`select indexname, indexdef from pg_indexes where indexdef ilike '%hnsw%'`);
    const defs = res.rows.map((r) => (r as { indexdef: string }).indexdef).join("\n");
    expect(defs).toMatch(/evidence_embeddings USING hnsw \(embedding vector_cosine_ops\)/);
    expect(defs).toMatch(/events USING hnsw \(centroid vector_cosine_ops\)/);
  });

  it("seeds, and re-seeding is idempotent and safe", async () => {
    const config = loadConfig();
    const first = await seed(db, config);
    expect(first.tracksInserted).toBe(config.profile.tracks.length);

    // Simulate runtime state and an owner edit made in Settings.
    const [src] = await db.select().from(schema.sources).limit(1);
    await db.insert(schema.sourceState).values({ sourceId: src!.id, watermark: { lastSeen: "fixture-watermark" } });
    await db.update(schema.sources).set({ currentStatus: "active" }).where(eq(schema.sources.id, src!.id));
    await db.update(schema.settings).set({ value: { daily_llm_usd: 9 } }).where(eq(schema.settings.key, "budget"));
    await db.update(schema.tracks).set({ priority: 99 }).where(eq(schema.tracks.id, "economy"));

    const second = await seed(db, config);
    expect(second).toMatchObject({ tracksInserted: 0, watchlistInserted: 0, settingsInserted: 0 });

    const [state] = await db.select().from(schema.sourceState).where(eq(schema.sourceState.sourceId, src!.id));
    expect(state!.watermark).toEqual({ lastSeen: "fixture-watermark" });
    const [srcAfter] = await db.select().from(schema.sources).where(eq(schema.sources.id, src!.id));
    expect(srcAfter!.currentStatus).toBe("active");
    const [budget] = await db.select().from(schema.settings).where(eq(schema.settings.key, "budget"));
    expect(budget!.value).toEqual({ daily_llm_usd: 9 });
    const [econ] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, "economy"));
    expect(econ!.priority).toBe(99);

    // --reset-profile restores YAML values but still leaves runtime state alone.
    const reset = await seed(db, config, { resetProfile: true });
    expect(reset.profileReset).toBe(true);
    const [budget2] = await db.select().from(schema.settings).where(eq(schema.settings.key, "budget"));
    expect(budget2!.value).toEqual(config.profile.budget);
    const [state2] = await db.select().from(schema.sourceState).where(eq(schema.sourceState.sourceId, src!.id));
    expect(state2!.watermark).toEqual({ lastSeen: "fixture-watermark" });

    const audits = await db.select().from(schema.auditEvents);
    expect(audits.map((a) => a.action)).toEqual(["seed", "seed", "seed.reset_profile"]);
  });

  it("disables sources removed from YAML instead of deleting them", async () => {
    await db.insert(schema.sources).values({
      key: "fixture-removed-source", name: "Fixture source (test only)", connectorType: "rss",
      accessMethod: "public_feed", tracks: ["ai_tech"], config: {}, cadenceMinutes: 60, enabled: true,
    });
    const report = await seed(db, loadConfig());
    expect(report.sourcesDisabled).toEqual(["fixture-removed-source"]);
    const [row] = await db.select().from(schema.sources).where(eq(schema.sources.key, "fixture-removed-source"));
    expect(row!.enabled).toBe(false);
  });

  it("makes evidence_records append-only", async () => {
    const [src] = await db.select().from(schema.sources).limit(1);
    const [ev] = await db.insert(schema.evidenceRecords).values({
      sourceId: src!.id,
      canonicalUrl: "https://fixture.invalid/item-1",
      title: "Fixture evidence (test only)",
      fingerprint: "fixture-fingerprint-1",
      collectionMethod: "scheduled",
    }).returning();

    await expectPgError(db.update(schema.evidenceRecords).set({ title: "changed" })
      .where(eq(schema.evidenceRecords.id, ev!.id)), /append-only: UPDATE/);
    await expectPgError(db.delete(schema.evidenceRecords)
      .where(eq(schema.evidenceRecords.id, ev!.id)), /append-only: DELETE/);
    await expectPgError(db.execute(sql`truncate evidence_records cascade`), /append-only: TRUNCATE/);

    // Side tables are writable and deletable (embeddings, raw payload retention).
    await db.insert(schema.evidenceRaw).values({ evidenceId: ev!.id, raw: { fixture: true } });
    await db.delete(schema.evidenceRaw).where(eq(schema.evidenceRaw.evidenceId, ev!.id));
    const vec = `[${Array.from({ length: schema.EMBEDDING_DIM }, () => 0.01).join(",")}]`;
    await db.execute(sql`insert into evidence_embeddings (evidence_id, model, embedding) values (${ev!.id}, 'fixture', ${vec}::vector)`);

    const [still] = await db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.id, ev!.id));
    expect(still!.title).toBe("Fixture evidence (test only)");
  });

  it("rejects a duplicate fingerprint", async () => {
    const [src] = await db.select().from(schema.sources).limit(1);
    const row = {
      sourceId: src!.id, canonicalUrl: "https://fixture.invalid/item-2", title: "Fixture (test only)",
      fingerprint: "fixture-fingerprint-2", collectionMethod: "scheduled" as const,
    };
    await db.insert(schema.evidenceRecords).values(row);
    await expectPgError(db.insert(schema.evidenceRecords).values(row), /evidence_fingerprint/);
  });
});
