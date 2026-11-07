// Connector runner: docs/PHASE1_SPEC.md §6.1.
// - Writes a connector_runs row on start and updates it on finish.
// - Maps failures to statuses: 401/403 -> auth_required, 429 -> rate_limited,
//   robots disallow -> unsupported, other errors -> limited, then unavailable
//   after 3 consecutive failures.
// - Inserts evidence append-only, deduped by fingerprint, with the raw payload
//   in evidence_raw in the same transaction.
// - Advances the watermark (source_state) only after a successful run.
import { eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../db.js";
import { canonicalUrl, fingerprint } from "../pipeline/normalize.js";
import { HttpClient, HttpError, MissingCredentialError, RobotsDisallowedError, redactUrl } from "./http.js";
import { getConnector } from "./index.js";
import type { ConnectorStatus, RunContext, Source } from "./types.js";

const { sources, sourceState, connectorRuns, evidenceRecords, evidenceRaw } = schema;

export const FAILURES_BEFORE_UNAVAILABLE = 3;
/** Re-read this much before the watermark so late-published items aren't missed. Dedupe absorbs the overlap. */
const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_LOOKBACK_HOURS = 48;

export type CollectionMethod = (typeof schema.evidenceRecords.$inferInsert)["collectionMethod"];

export interface RunOptions {
  http?: HttpClient;
  now?: () => Date;
  force?: boolean;
  collectionMethod?: CollectionMethod;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RunResult {
  sourceKey: string;
  runId: string;
  status: ConnectorStatus;
  sourceStatus: ConnectorStatus;
  itemsFetched: number;
  itemsNew: number;
  itemsSkippedOld: number;
  itemsInvalid: number;
  error: string | null;
}

export class SourceNotRunnableError extends Error {}

export function classifyError(err: unknown): ConnectorStatus {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return "auth_required";
    if (err.status === 429) return "rate_limited";
    return "unavailable";
  }
  if (err instanceof MissingCredentialError) return "auth_required";
  if (err instanceof RobotsDisallowedError) return "unsupported";
  return "unavailable";
}

export async function runSource(db: Db, sourceKey: string, opts: RunOptions = {}): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const http = opts.http ?? new HttpClient();

  const [source] = await db.select().from(sources).where(eq(sources.key, sourceKey));
  if (!source) throw new SourceNotRunnableError(`unknown source: ${sourceKey}`);
  if (!source.enabled && !opts.force) throw new SourceNotRunnableError(`source ${sourceKey} is disabled (pass --force to run anyway)`);
  const connector = getConnector(source.connectorType);
  if (!connector) throw new SourceNotRunnableError(`no connector for type ${source.connectorType}`);

  await db.insert(sourceState).values({ sourceId: source.id }).onConflictDoNothing();
  const [state] = await db.select().from(sourceState).where(eq(sourceState.sourceId, source.id));
  const prevWatermark = (state?.watermark ?? {}) as Record<string, unknown>;

  const startedAt = now();
  // status is provisional while finished_at is null.
  const [run] = await db.insert(connectorRuns)
    .values({ sourceId: source.id, startedAt, status: "active" })
    .returning({ id: connectorRuns.id });
  const runId = run!.id;

  const since = sinceFor(source, prevWatermark, startedAt);
  const watermarkPatch: Record<string, unknown> = {};
  const ctx: RunContext = {
    http,
    now: startedAt,
    watermark: prevWatermark,
    setWatermark: (patch) => Object.assign(watermarkPatch, patch),
    log: (msg, extra) => log(`[${source.key}] ${msg}`, extra),
  };

  let itemsFetched = 0, itemsNew = 0, itemsSkippedOld = 0, itemsInvalid = 0;
  let maxPublished: Date | null = null;

  try {
    for await (const raw of connector.fetch(source, since, ctx)) {
      itemsFetched++;
      let item;
      try {
        item = connector.normalize(raw, source);
      } catch (err) {
        itemsInvalid++;
        ctx.log("skipped invalid item", { error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      // Date-only items (midnight of their day) are compared a day earlier, so an
      // item dated today isn't dropped because the window opened mid-day.
      const floor = item.datePrecision === "day" ? new Date(since.getTime() - 86_400_000) : since;
      if (item.publishedAt && item.publishedAt < floor) {
        itemsSkippedOld++;
        continue;
      }
      let url: string;
      try {
        url = canonicalUrl(item.url);
      } catch {
        itemsInvalid++;
        ctx.log("skipped item with invalid url", { url: redactUrl(item.url) });
        continue;
      }
      if (item.publishedAt && (!maxPublished || item.publishedAt > maxPublished)) maxPublished = item.publishedAt;

      const inserted = await db.transaction(async (tx) => {
        const rows = await tx.insert(evidenceRecords).values({
          sourceId: source.id,
          sourceItemId: item.sourceItemId ?? null,
          canonicalUrl: url,
          title: item.title,
          excerpt: item.excerpt ?? null,
          author: item.author ?? null,
          language: item.language ?? null,
          publishedAt: item.publishedAt ?? null,
          eventOccurredAt: item.eventOccurredAt ?? null,
          fingerprint: fingerprint({ canonicalUrl: url, sourceKey: source.key, sourceItemId: item.sourceItemId }),
          collectionMethod: opts.collectionMethod ?? "scheduled",
          permittedUse: String((source.config as Record<string, unknown>).permitted_use ?? "headline_excerpt"),
        }).onConflictDoNothing({ target: evidenceRecords.fingerprint }).returning({ id: evidenceRecords.id });
        const id = rows[0]?.id;
        if (id) await tx.insert(evidenceRaw).values({ evidenceId: id, raw: item.raw as object });
        return Boolean(id);
      });
      if (inserted) itemsNew++;
    }
  } catch (err) {
    const status = classifyError(err);
    const failures = (state?.consecutiveFailures ?? 0) + 1;
    const sourceStatus: ConnectorStatus = status === "unavailable"
      ? (failures >= FAILURES_BEFORE_UNAVAILABLE ? "unavailable" : "limited")
      : status;
    const message = redactUrl(err instanceof Error ? `${err.name}: ${err.message}` : String(err));

    await db.update(connectorRuns).set({
      finishedAt: now(), status, itemsFetched, itemsNew, error: message,
    }).where(eq(connectorRuns.id, runId));
    await db.update(sourceState).set({ consecutiveFailures: failures, updatedAt: sql`now()` })
      .where(eq(sourceState.sourceId, source.id));
    await db.update(sources).set({ currentStatus: sourceStatus }).where(eq(sources.id, source.id));
    ctx.log("run failed", { status, error: message });
    return { sourceKey: source.key, runId, status, sourceStatus, itemsFetched, itemsNew, itemsSkippedOld, itemsInvalid, error: message };
  }

  const prevLastSeen = typeof prevWatermark.lastSeen === "string" ? new Date(prevWatermark.lastSeen) : null;
  const lastSeen = [prevLastSeen, maxPublished].filter((d): d is Date => d !== null)
    .reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
  const watermark = dropUndefined({ ...prevWatermark, ...watermarkPatch, lastSeen: lastSeen?.toISOString() });

  await db.update(connectorRuns).set({ finishedAt: now(), status: "active", itemsFetched, itemsNew })
    .where(eq(connectorRuns.id, runId));
  await db.update(sourceState).set({ watermark, consecutiveFailures: 0, updatedAt: sql`now()` })
    .where(eq(sourceState.sourceId, source.id));
  await db.update(sources).set({ currentStatus: "active" }).where(eq(sources.id, source.id));
  ctx.log("run finished", { itemsFetched, itemsNew, itemsSkippedOld, itemsInvalid });
  return { sourceKey: source.key, runId, status: "active", sourceStatus: "active", itemsFetched, itemsNew, itemsSkippedOld, itemsInvalid, error: null };
}

export function sinceFor(source: Source, watermark: Record<string, unknown>, now: Date): Date {
  if (typeof watermark.lastSeen === "string") {
    const t = Date.parse(watermark.lastSeen);
    if (Number.isFinite(t)) return new Date(t - WATERMARK_OVERLAP_MS);
  }
  const hours = Number((source.config as Record<string, unknown>).initial_lookback_hours ?? DEFAULT_INITIAL_LOOKBACK_HOURS);
  return new Date(now.getTime() - hours * 3_600_000);
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
