// Classification: docs/PHASE1_SPEC.md §7.1.
// Batches of up to 25 unclassified items go to MODEL_CLASSIFY with the track
// definitions and watchlist read from the DB. Items are referenced as e1..eN and
// watchlist entities as w1..wN so the model never handles UUIDs.
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { schema, ClassificationOutputSchema, type ClassifiedItem } from "@ioc/shared";
import { z } from "zod";
import type { Db } from "../db.js";
import { BudgetExceededError, budgetState } from "../llm/budget.js";
import { LlmOutputError, LlmStopError, type LlmClient } from "../llm/client.js";
import { MissingPriceError } from "../llm/pricing.js";
import { loadPrompt } from "../llm/prompts.js";
import { getSetting } from "../llm/settings.js";

const { evidenceRecords, classifications, sources, tracks, watchlistEntities, auditEvents } = schema;

export const MAX_BATCH = 25;

type Track = typeof tracks.$inferSelect;
type Watch = typeof watchlistEntities.$inferSelect;

export interface ClassifyOptions {
  model: string;
  batchSize?: number;
  maxBatches?: number;
  runRef?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ClassifyReport {
  batches: number;
  classified: number;
  missingFromOutput: number;
  failedBatches: number;
  stoppedForBudget: boolean;
  lowPriorityPaused: boolean;
  costUsd: number;
}

/** Relevance gate (§7.1): noise, or relevance below the gate without a watchlist hit, is not embedded or clustered. */
export function passesGate(c: { isNoise: boolean; relevance: number; watchlistHits: string[] }, gate: number): boolean {
  return !c.isNoise && (c.relevance >= gate || c.watchlistHits.length > 0);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Deterministic watchlist keyword matches in title + excerpt (case-insensitive, whole words). */
export function keywordHits(text: string, watchlist: Pick<Watch, "id" | "keywords">[]): string[] {
  const hits: string[] = [];
  for (const w of watchlist) {
    if (w.keywords.some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k)}($|[^\\p{L}\\p{N}])`, "iu").test(text))) hits.push(w.id);
  }
  return hits;
}

export function buildSystemPrompt(template: string, owner: { context: string; organizations: string[] }, trackRows: Track[], watch: Watch[]): string {
  const trackLines = [...trackRows].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((t) => `- ${t.id}: ${t.title}. ${t.description}`).join("\n");
  const watchLines = watch.length
    ? watch.map((w, i) => `- w${i + 1}: ${w.name} (${w.kind}). Keywords: ${w.keywords.join(", ")}`).join("\n")
    : "- (none)";
  return template
    .replace("{{OWNER_CONTEXT}}", `${owner.context.trim()} Organizations: ${owner.organizations.join(", ")}.`)
    .replace("{{TRACKS}}", trackLines)
    .replace("{{WATCHLIST}}", watchLines);
}

const OwnerSchema = z.object({ name: z.string(), organizations: z.array(z.string()), context: z.string() });

export async function classifyPending(db: Db, llm: LlmClient, opts: ClassifyOptions): Promise<ClassifyReport> {
  const log = opts.log ?? (() => {});
  const batchSize = Math.min(opts.batchSize ?? MAX_BATCH, MAX_BATCH);
  const prompt = loadPrompt("classify");

  // Settings are read once per run, from the DB.
  const owner = await getSetting(db, "owner", OwnerSchema);
  const trackRows = await db.select().from(tracks).where(eq(tracks.enabled, true));
  const watch = (await db.select().from(watchlistEntities)).sort((a, b) => a.name.localeCompare(b.name));
  const system = buildSystemPrompt(prompt.text, owner, trackRows, watch);
  const trackIds = new Set(trackRows.map((t) => t.id));
  const watchByRef = new Map(watch.map((w, i) => [`w${i + 1}`, w.id]));

  const report: ClassifyReport = {
    batches: 0, classified: 0, missingFromOutput: 0, failedBatches: 0,
    stoppedForBudget: false, lowPriorityPaused: false, costUsd: 0,
  };
  const attempted: string[] = [];

  while (opts.maxBatches === undefined || report.batches < opts.maxBatches) {
    const budget = await budgetState(db);
    if (budget.exhausted) {
      report.stoppedForBudget = true;
      log("budget exhausted; stopping classification", { spent: budget.spentUsd });
      break;
    }
    report.lowPriorityPaused ||= budget.lowPriorityPaused;

    const conditions = [isNull(classifications.evidenceId)];
    if (budget.lowPriorityPaused) conditions.push(sql`${sources.priority} <> 'low'`);
    if (attempted.length) conditions.push(notInArray(evidenceRecords.id, attempted));
    const rows = await db.select({
      id: evidenceRecords.id, title: evidenceRecords.title, excerpt: evidenceRecords.excerpt,
      publishedAt: evidenceRecords.publishedAt, eventOccurredAt: evidenceRecords.eventOccurredAt, sourceName: sources.name,
    }).from(evidenceRecords)
      .innerJoin(sources, eq(sources.id, evidenceRecords.sourceId))
      .leftJoin(classifications, eq(classifications.evidenceId, evidenceRecords.id))
      .where(and(...conditions))
      .orderBy(asc(evidenceRecords.retrievedAt), asc(evidenceRecords.id))
      .limit(batchSize);
    if (!rows.length) break;
    attempted.push(...rows.map((r) => r.id));
    report.batches++;

    const refToId = new Map(rows.map((r, i) => [`e${i + 1}`, r.id]));
    const user = "Classify these items:\n" + rows.map((r, i) => JSON.stringify({
      id: `e${i + 1}`,
      title: r.title,
      excerpt: r.excerpt,
      source_name: r.sourceName,
      published_at: (r.publishedAt ?? r.eventOccurredAt)?.toISOString() ?? null,
    })).join("\n");

    let output: ClassifiedItem[];
    try {
      const res = await llm.structured({
        purpose: "classify", model: opts.model, system, user, schema: ClassificationOutputSchema,
        maxTokens: 16_000, effort: "low", runRef: opts.runRef,
      });
      output = res.data.items;
      report.costUsd += res.costUsd;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        report.stoppedForBudget = true;
        break;
      }
      if (err instanceof MissingPriceError) throw err;
      if (err instanceof LlmOutputError || err instanceof LlmStopError) {
        report.failedBatches++;
        await db.insert(auditEvents).values({
          actor: "job:classify", action: "classify.batch_failed", targetType: "evidence_batch",
          detail: { error: err.message, evidence_ids: rows.map((r) => r.id), ...(err instanceof LlmOutputError ? { issues: err.issues } : {}) },
        });
        log("batch failed; items stay unclassified for the next run", { error: err.message });
        continue;
      }
      throw err;
    }

    const seen = new Set<string>();
    const values: (typeof classifications.$inferInsert)[] = [];
    for (const item of output) {
      const evidenceId = refToId.get(item.id);
      if (!evidenceId || seen.has(evidenceId)) continue;
      seen.add(evidenceId);
      const row = rows.find((r) => r.id === evidenceId)!;
      const modelHits = item.watchlist_hits.map((r) => watchByRef.get(r)).filter((x): x is string => Boolean(x));
      const hits = [...new Set([...modelHits, ...keywordHits(`${row.title} ${row.excerpt ?? ""}`, watch)])];
      values.push({
        evidenceId,
        tracks: [...new Set(item.tracks.filter((t) => trackIds.has(t)))],
        geography: item.geography,
        entities: item.entities,
        topics: item.topics,
        relevance: item.relevance,
        importance: item.importance,
        isNoise: item.is_noise,
        watchlistHits: hits,
        model: opts.model,
        promptVersion: prompt.version,
      });
    }
    if (values.length) await db.insert(classifications).values(values).onConflictDoNothing();
    report.classified += values.length;
    report.missingFromOutput += rows.length - values.length;
    log("batch classified", { items: rows.length, classified: values.length });
  }
  return report;
}
