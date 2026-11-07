// Event clustering + significance: docs/PHASE1_SPEC.md §7.2. Deterministic.
//
// For each embedded, gated, non-duplicate item not yet in an event, oldest first:
//  1. Candidates: non-stale events with last_seen_at within 72h of the item,
//     overlapping tracks, and cosine(centroid, item) >= cluster_join_cosine.
//  2. Join the best candidate if it shares an entity with the item or its
//     cosine >= cluster_strong_cosine. Locations don't count as shared
//     entities (a shared country alone would merge unrelated stories).
//  3. Otherwise create an event titled with the item's title.
// Then every non-stale event is refreshed: counts, status, significance.
import { asc, eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../db.js";
import { getRanking } from "../llm/settings.js";
import { hostSql } from "./embed.js";

const { events, eventEvidence } = schema;

export const WINDOW_HOURS = 72;
export const STALE_DAYS = 7;
const CLUSTER_LOCK = 7_310_400_402; // pg advisory lock id for the cluster job

type Ranking = Awaited<ReturnType<typeof getRanking>>;

export interface EventStats {
  maxImportance: number;
  maxRelevance: number;
  distinctSources: number;
  hasPrimarySource: boolean;
  watchlistHit: boolean;
  lastSeenAt: Date;
}

/** Spec §7.2 significance. Age is hours since the event's latest item. */
export function significance(s: EventStats, w: Ranking["weights"], now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - s.lastSeenAt.getTime()) / 3_600_000);
  const score = s.maxImportance * w.importance
    + s.maxRelevance * w.relevance
    + Math.min(s.distinctSources, 5) * w.per_distinct_source
    + (s.hasPrimarySource ? w.primary_source_bonus : 0)
    + (s.watchlistHit ? w.watchlist_bonus : 0)
    - ageHours * w.age_penalty_per_hour;
  return Math.round(score * 100) / 100;
}

export function eventStatus(s: Pick<EventStats, "distinctSources" | "hasPrimarySource" | "lastSeenAt">, now: Date): "developing" | "confirmed" | "stale" {
  if (now.getTime() - s.lastSeenAt.getTime() > STALE_DAYS * 86_400_000) return "stale";
  return s.distinctSources >= 2 || s.hasPrimarySource ? "confirmed" : "developing";
}

export function normalizeEntity(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Entity keys that count for joining (locations excluded). */
export function joinableEntities(entities: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(entities)) return out;
  for (const e of entities as { name?: unknown; type?: unknown }[]) {
    if (typeof e?.name !== "string" || e.type === "location") continue;
    const key = normalizeEntity(e.name);
    if (key.length >= 2) out.add(key);
  }
  return out;
}

export function runningMean(centroid: number[], n: number, v: number[]): number[] {
  return centroid.map((c, i) => (c * n + v[i]!) / (n + 1));
}

export interface ClusterReport { assigned: number; joined: number; created: number; refreshed: number; skippedLocked: boolean }

export async function clusterPending(db: Db, opts: { now?: Date; log?: (m: string, e?: Record<string, unknown>) => void } = {}): Promise<ClusterReport> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const report: ClusterReport = { assigned: 0, joined: 0, created: 0, refreshed: 0, skippedLocked: false };

  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(${CLUSTER_LOCK}) as ok`);
    if (!(lock.rows[0] as { ok: boolean }).ok) {
      report.skippedLocked = true;
      return report;
    }
    const ranking = await getRanking(tx as unknown as Db);

    const pending = await tx.execute(sql`
      select e.id, coalesce(e.published_at, e.retrieved_at) as t, e.title,
             c.tracks, c.entities, ee.embedding::text as embedding
      from evidence_records e
      join evidence_embeddings ee on ee.evidence_id = e.id
      join classifications c on c.evidence_id = e.id
      where not exists (select 1 from evidence_duplicates d where d.evidence_id = e.id)
        and not exists (select 1 from event_evidence x where x.evidence_id = e.id)
      order by t asc, e.id asc`);

    for (const row of pending.rows as { id: string; t: Date | string; title: string; tracks: string[]; entities: unknown; embedding: string }[]) {
      const t = new Date(row.t);
      const vec = JSON.parse(row.embedding) as number[];
      const vecLit = row.embedding;
      const candidates = row.tracks.length ? await tx.execute(sql`
        select ev.id, 1 - (ev.centroid <=> ${vecLit}::vector) as cos
        from events ev
        where ev.status <> 'stale'
          and ev.centroid is not null
          and ev.tracks && array[${sql.join(row.tracks.map((t) => sql`${t}`), sql`, `)}]::text[]
          and ev.last_seen_at >= ${t.toISOString()}::timestamptz - make_interval(hours => ${WINDOW_HOURS})
          and ev.first_seen_at <= ${t.toISOString()}::timestamptz + make_interval(hours => ${WINDOW_HOURS})
        order by ev.centroid <=> ${vecLit}::vector
        limit 1`) : { rows: [] };
      const best = candidates.rows[0] as { id: string; cos: number } | undefined;

      let eventId: string | null = null;
      if (best && Number(best.cos) >= ranking.cluster_join_cosine) {
        let ok = Number(best.cos) >= ranking.cluster_strong_cosine;
        if (!ok) {
          const itemEntities = joinableEntities(row.entities);
          if (itemEntities.size) {
            const members = await tx.execute(sql`
              select c.entities from event_evidence x join classifications c on c.evidence_id = x.evidence_id
              where x.event_id = ${best.id}`);
            ok = (members.rows as { entities: unknown }[]).some((m) => [...joinableEntities(m.entities)].some((k) => itemEntities.has(k)));
          }
        }
        if (ok) eventId = best.id;
      }

      if (eventId) {
        const [ev] = await tx.select().from(events).where(eq(events.id, eventId));
        const [{ n }] = (await tx.execute(sql`select count(*)::int as n from event_evidence where event_id = ${eventId}`)).rows as [{ n: number }];
        await tx.update(events).set({
          centroid: runningMean(ev!.centroid ?? vec, n, vec),
          tracks: [...new Set([...ev!.tracks, ...row.tracks])].sort(),
          firstSeenAt: t < ev!.firstSeenAt ? t : ev!.firstSeenAt,
          lastSeenAt: t > ev!.lastSeenAt ? t : ev!.lastSeenAt,
        }).where(eq(events.id, eventId));
        report.joined++;
      } else {
        const [ev] = await tx.insert(events).values({
          title: row.title, tracks: [...row.tracks].sort(), firstSeenAt: t, lastSeenAt: t, centroid: vec,
        }).returning({ id: events.id });
        eventId = ev!.id;
        report.created++;
      }
      await tx.insert(eventEvidence).values({ eventId, evidenceId: row.id }).onConflictDoNothing();
      report.assigned++;
    }

    report.refreshed = await refreshEvents(tx as unknown as Db, ranking, now);
    log("cluster run finished", { ...report });
    return report;
  });
}

/** Recompute counts, status, and significance for every non-stale event. */
export async function refreshEvents(db: Db, ranking: Ranking, now: Date): Promise<number> {
  const stats = await db.execute(sql`
    select ev.id,
           max(c.importance) as max_importance,
           max(c.relevance) as max_relevance,
           count(distinct ${hostSql(sql`e.canonical_url`)})::int as distinct_sources,
           bool_or(s.is_primary) as has_primary,
           bool_or(cardinality(c.watchlist_hits) > 0) as watchlist_hit,
           max(coalesce(e.published_at, e.retrieved_at)) as last_seen
    from events ev
    join event_evidence x on x.event_id = ev.id
    join evidence_records e on e.id = x.evidence_id
    join sources s on s.id = e.source_id
    join classifications c on c.evidence_id = e.id
    where ev.status <> 'stale'
    group by ev.id`);
  let n = 0;
  for (const r of stats.rows as { id: string; max_importance: number; max_relevance: number; distinct_sources: number; has_primary: boolean; watchlist_hit: boolean; last_seen: Date | string }[]) {
    const s: EventStats = {
      maxImportance: Number(r.max_importance), maxRelevance: Number(r.max_relevance),
      distinctSources: Number(r.distinct_sources), hasPrimarySource: Boolean(r.has_primary),
      watchlistHit: Boolean(r.watchlist_hit), lastSeenAt: new Date(r.last_seen),
    };
    await db.update(events).set({
      distinctSources: s.distinctSources,
      hasPrimarySource: s.hasPrimarySource,
      lastSeenAt: s.lastSeenAt,
      status: eventStatus(s, now),
      significance: significance(s, ranking.weights, now),
    }).where(eq(events.id, r.id));
    n++;
  }
  return n;
}

/** For manual spot checks: events with their member titles and hosts. */
export async function eventDigest(db: Db, limit = 50) {
  const evs = await db.select().from(events).orderBy(asc(events.status), sql`${events.significance} desc`).limit(limit);
  const out = [];
  for (const ev of evs) {
    const members = await db.execute(sql`
      select e.title, ${hostSql(sql`e.canonical_url`)} as host
      from event_evidence x join evidence_records e on e.id = x.evidence_id
      where x.event_id = ${ev.id} order by coalesce(e.published_at, e.retrieved_at)`);
    out.push({ ...ev, centroid: undefined, members: members.rows as { title: string; host: string }[] });
  }
  return out;
}
