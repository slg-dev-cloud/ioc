// Embeddings + near-duplicate detection: docs/PHASE1_SPEC.md §6.2, §7.1.
// Only classified items that pass the relevance gate are embedded. After
// embedding, an item with cosine >= 0.95 to an older item from the same host
// within 48h is recorded in evidence_duplicates (the evidence row is untouched).
import { and, asc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../db.js";
import { BudgetExceededError } from "../llm/budget.js";
import type { LlmClient } from "../llm/client.js";
import { priceFor } from "../llm/pricing.js";
import { getPricing, getRanking } from "../llm/settings.js";
import { checkDimensions, type EmbeddingProvider } from "./embeddings/provider.js";

const { evidenceRecords, classifications, evidenceEmbeddings, evidenceDuplicates } = schema;

export const NEAR_DUP_COSINE = 0.95;
export const NEAR_DUP_WINDOW_HOURS = 48;

export interface EmbedOptions { batchSize?: number; maxBatches?: number; runRef?: string; log?: (m: string, e?: Record<string, unknown>) => void }
export interface EmbedReport { batches: number; embedded: number; duplicates: number; stoppedForBudget: boolean; costUsd: number }

export function embeddingText(title: string, excerpt: string | null): string {
  return excerpt ? `${title}\n\n${excerpt}` : title;
}

/** Host without a leading "www.", as SQL. Used for near-dup and (later) distinct-source counting. */
export const hostSql = (col: unknown) => sql`lower(regexp_replace(${col}, '^[a-z]+://(www\\.)?([^/:?#]+).*$', '\\2', 'i'))`;

export async function embedPending(db: Db, llm: LlmClient, provider: EmbeddingProvider, opts: EmbedOptions = {}): Promise<EmbedReport> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? 64;
  const { relevance_gate: gate } = await getRanking(db);
  priceFor(await getPricing(db), provider.model); // refuse before spending if unpriced

  const report: EmbedReport = { batches: 0, embedded: 0, duplicates: 0, stoppedForBudget: false, costUsd: 0 };
  const attempted: string[] = [];

  while (opts.maxBatches === undefined || report.batches < opts.maxBatches) {
    const conds = [
      isNull(evidenceEmbeddings.evidenceId),
      eq(classifications.isNoise, false),
      or(sql`${classifications.relevance} >= ${gate}`, sql`cardinality(${classifications.watchlistHits}) > 0`)!,
    ];
    if (attempted.length) conds.push(notInArray(evidenceRecords.id, attempted));
    const rows = await db.select({ id: evidenceRecords.id, title: evidenceRecords.title, excerpt: evidenceRecords.excerpt })
      .from(evidenceRecords)
      .innerJoin(classifications, eq(classifications.evidenceId, evidenceRecords.id))
      .leftJoin(evidenceEmbeddings, eq(evidenceEmbeddings.evidenceId, evidenceRecords.id))
      .where(and(...conds))
      .orderBy(asc(evidenceRecords.retrievedAt), asc(evidenceRecords.id))
      .limit(batchSize);
    if (!rows.length) break;
    attempted.push(...rows.map((r) => r.id));

    try {
      await llm.assertBudget();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        report.stoppedForBudget = true;
        break;
      }
      throw err;
    }

    const started = Date.now();
    const result = await provider.embedDocuments(rows.map((r) => embeddingText(r.title, r.excerpt)));
    checkDimensions(result, provider.dimensions, rows.length);
    report.costUsd += await llm.recordExternalCall({
      purpose: "embed", model: provider.model, usage: { inputTokens: result.totalTokens, outputTokens: 0 },
      latencyMs: Date.now() - started, runRef: opts.runRef,
    });

    await db.insert(evidenceEmbeddings).values(rows.map((r, i) => ({
      evidenceId: r.id, model: provider.model, embedding: result.vectors[i]!,
    }))).onConflictDoNothing();
    report.batches++;
    report.embedded += rows.length;

    for (const r of rows) if (await markIfNearDuplicate(db, r.id)) report.duplicates++;
    log("batch embedded", { items: rows.length });
  }
  return report;
}

/** Records `evidenceId` as a near-duplicate of an older same-host item, if one exists. */
export async function markIfNearDuplicate(db: Db, evidenceId: string): Promise<boolean> {
  const t1 = sql`coalesce(e1.published_at, e1.retrieved_at)`;
  const t2 = sql`coalesce(e2.published_at, e2.retrieved_at)`;
  const res = await db.execute(sql`
    select e2.id as dup_of, 1 - (ee2.embedding <=> ee1.embedding) as sim
    from evidence_embeddings ee1
    join evidence_records e1 on e1.id = ee1.evidence_id
    join evidence_embeddings ee2 on ee2.evidence_id <> ee1.evidence_id
    join evidence_records e2 on e2.id = ee2.evidence_id
    where ee1.evidence_id = ${evidenceId}
      and ${hostSql(sql`e2.canonical_url`)} = ${hostSql(sql`e1.canonical_url`)}
      and ${t2} <= ${t1}
      and ${t2} >= ${t1} - make_interval(hours => ${NEAR_DUP_WINDOW_HOURS})
      and not exists (select 1 from evidence_duplicates d where d.evidence_id = e2.id)
    order by ee2.embedding <=> ee1.embedding
    limit 1`);
  const best = res.rows[0] as { dup_of: string; sim: number } | undefined;
  if (!best || Number(best.sim) < NEAR_DUP_COSINE) return false;
  await db.insert(evidenceDuplicates).values({ evidenceId, dupOfId: best.dup_of, cosine: Number(best.sim) }).onConflictDoNothing();
  return true;
}
