// LLM client, pricing, budget, classification, and embeddings with fake model
// APIs against the real test database. No network.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import { z } from "zod";
import type { Db } from "../src/db.js";
import { budgetState, BudgetExceededError } from "../src/llm/budget.js";
import { LlmClient, LlmOutputError, LlmStopError, type MessagesApi } from "../src/llm/client.js";
import { costUsd, MissingPriceError } from "../src/llm/pricing.js";
import { loadPrompt } from "../src/llm/prompts.js";
import { buildSystemPrompt, classifyPending, keywordHits, passesGate } from "../src/pipeline/classify.js";
import { embedPending, embeddingText } from "../src/pipeline/embed.js";
import { checkDimensions, EmbeddingDimensionError, type EmbeddingProvider } from "../src/pipeline/embeddings/provider.js";
import { VoyageProvider, VOYAGE_ENDPOINT } from "../src/pipeline/embeddings/voyage.js";
import { loadConfig, seed } from "../src/seed.js";
import { freshDb, testDbUrl } from "./helpers/db.js";

const MODEL = "claude-haiku-5-5";
const EMBED_MODEL = "fixture-embed-model";
const DIM = schema.EMBEDDING_DIM;

type ParseParams = Parameters<MessagesApi["parse"]>[0];
function fakeMessages(respond: (p: ParseParams, n: number) => { parsed: unknown; stop?: string; usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }> }) {
  const calls: ParseParams[] = [];
  const api: MessagesApi = {
    async parse(p) {
      calls.push(p);
      const r = respond(p, calls.length);
      return {
        content: [], stop_reason: r.stop ?? "end_turn", parsed_output: r.parsed,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...r.usage } as never,
      };
    },
  };
  return { api, calls };
}

/** Echoes every e-ref from the user message with fixed scores. */
function echoClassifier(over: (ref: string, title: string) => Record<string, unknown> = () => ({})) {
  return (p: ParseParams) => {
    const text = String((p.messages[0] as { content: string }).content);
    const items = [...text.matchAll(/\{"id":"(e\d+)","title":"([^"]*)"/g)].map(([, id, title]) => ({
      id, tracks: ["ai_tech"], geography: ["Global"], entities: [], topics: ["fixture"],
      relevance: 50, importance: 40, is_noise: false, watchlist_hits: [], ...over(id!, title!),
    }));
    return { parsed: { items } };
  };
}

describe("pure helpers", () => {
  it("computes cost from tokens, including cache reads and writes", () => {
    const price = { input_per_mtok: 2, output_per_mtok: 10, cache_read_per_mtok: 0.2 };
    expect(costUsd(price, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBe(3);
    // default write price = 1.25x input
    expect(costUsd(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toBe(2.7);
  });

  it("loads versioned prompts", () => {
    expect(loadPrompt("classify").version).toBe("classify-v1");
  });

  it("applies the relevance gate", () => {
    expect(passesGate({ isNoise: false, relevance: 35, watchlistHits: [] }, 35)).toBe(true);
    expect(passesGate({ isNoise: false, relevance: 10, watchlistHits: [] }, 35)).toBe(false);
    expect(passesGate({ isNoise: false, relevance: 10, watchlistHits: ["w"] }, 35)).toBe(true);
    expect(passesGate({ isNoise: true, relevance: 99, watchlistHits: ["w"] }, 35)).toBe(false);
  });

  it("matches watchlist keywords as whole words, case-insensitively", () => {
    const w = [{ id: "a", keywords: ["Plaid", "Section 1033"] }, { id: "b", keywords: ["HIPAA"] }];
    expect(keywordHits("CFPB finalizes section 1033 rule; Plaid responds", w)).toEqual(["a"]);
    expect(keywordHits("Plaidwear launches", w)).toEqual([]);
    expect(keywordHits("New hipaa guidance", w)).toEqual(["b"]);
  });

  it("checks embedding dimensions and count", () => {
    expect(() => checkDimensions({ vectors: [[1, 2]], totalTokens: 1 }, 3, 1)).toThrow(EmbeddingDimensionError);
    expect(() => checkDimensions({ vectors: [], totalTokens: 1 }, 3, 1)).toThrow(EmbeddingDimensionError);
  });

  it("sends the documented Voyage request and reorders by index", async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
    const v = new VoyageProvider("FIXTURE-KEY", "voyage-fixture", 2, async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization! };
      return new Response(JSON.stringify({ data: [{ embedding: [0, 1], index: 1 }, { embedding: [1, 0], index: 0 }], usage: { total_tokens: 7 } }));
    });
    const r = await v.embedDocuments(["a", "b"]);
    expect(seen!.url).toBe(VOYAGE_ENDPOINT);
    expect(seen!.body).toEqual({ input: ["a", "b"], model: "voyage-fixture", input_type: "document", output_dimension: 2 });
    expect(seen!.auth).toBe("Bearer FIXTURE-KEY");
    expect(r).toEqual({ vectors: [[1, 0], [0, 1]], totalTokens: 7 });
  });
});

describe.skipIf(!testDbUrl)("LLM pipeline (M3)", () => {
  let db: Db;
  let end: () => Promise<void>;
  let sourceId: string;
  let lowSourceId: string;
  let n = 0;

  beforeAll(async () => {
    ({ db, end } = await freshDb());
    await seed(db, loadConfig());
    await db.update(schema.settings).set({ value: {
      [MODEL]: { input_per_mtok: 0.1, output_per_mtok: 0.5 },
      [EMBED_MODEL]: { input_per_mtok: 0.06, output_per_mtok: 0, source: "fixture price for tests" },
    } }).where(eq(schema.settings.key, "model_pricing"));
    const [a] = await db.insert(schema.sources).values({ key: "fixture-llm-src", name: "Fixture source (test only)", connectorType: "rss", accessMethod: "public_feed", tracks: ["ai_tech"], config: {}, cadenceMinutes: 60 }).returning();
    const [b] = await db.insert(schema.sources).values({ key: "fixture-llm-low", name: "Fixture low-priority source", connectorType: "rss", accessMethod: "public_feed", tracks: ["family_life"], priority: "low", config: {}, cadenceMinutes: 60 }).returning();
    sourceId = a!.id;
    lowSourceId = b!.id;
  });
  afterAll(() => end?.());
  beforeEach(async () => {
    await db.execute(sql`truncate llm_calls, audit_events, evidence_duplicates, evidence_embeddings, classifications`);
  });

  async function addEvidence(title: string, opts: { excerpt?: string; host?: string; publishedAt?: Date; low?: boolean } = {}) {
    const id = ++n;
    const [row] = await db.insert(schema.evidenceRecords).values({
      sourceId: opts.low ? lowSourceId : sourceId,
      canonicalUrl: `https://${opts.host ?? "fixture.example.invalid"}/item-${id}`,
      title, excerpt: opts.excerpt ?? null, publishedAt: opts.publishedAt ?? new Date(),
      fingerprint: `fixture-llm-${id}-${Math.random()}`, collectionMethod: "scheduled",
    }).returning();
    return row!.id;
  }
  const calls = async () => db.select().from(schema.llmCalls);
  async function classifyAll(over?: Parameters<typeof echoClassifier>[0]) {
    const f = fakeMessages(echoClassifier(over));
    const report = await classifyPending(db, new LlmClient(db, f.api), { model: MODEL });
    return { report, f };
  }
  // Only items created in a test should be classified by it.
  async function onlyThese(ids: string[]) {
    await db.execute(sql`insert into classifications (evidence_id, tracks, geography, entities, topics, relevance, importance, is_noise, watchlist_hits, model, prompt_version)
      select id, '{}', '{}', '[]', '{}', 0, 0, true, '{}', 'fixture-preclassified', 'n/a' from evidence_records
      where id not in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
      on conflict do nothing`);
  }

  describe("LlmClient", () => {
    const S = z.object({ answer: z.number().int().min(0).max(10) });
    const req = { purpose: "classify" as const, model: MODEL, system: "fixture system prompt", user: "q", schema: S, effort: "low" as const };

    it("logs tokens and cost for every response, caches the system prompt, and sets effort", async () => {
      const f = fakeMessages(() => ({ parsed: { answer: 3 }, usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 1000 } }));
      const r = await new LlmClient(db, f.api).structured(req);
      expect(r.data).toEqual({ answer: 3 });
      const sys = f.calls[0]!.system as { cache_control?: unknown }[];
      expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect((f.calls[0] as { output_config?: { effort?: string; format?: { type: string } } }).output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
      expect(f.calls[0]).not.toHaveProperty("temperature");
      const [row] = await calls();
      expect(row).toMatchObject({ purpose: "classify", model: MODEL, inputTokens: 3000, outputTokens: 100 });
      expect(Number(row!.costUsd)).toBeCloseTo((2000 * 0.1 + 100 * 0.5 + 1000 * 0.01) / 1e6, 5);
    });

    it("makes one repair call, then gives up", async () => {
      const ok = fakeMessages((_, i) => ({ parsed: i === 1 ? { answer: 99 } : { answer: 4 } }));
      const r = await new LlmClient(db, ok.api).structured(req);
      expect(r).toMatchObject({ data: { answer: 4 }, repaired: true });
      expect(String((ok.calls[1]!.messages[0] as { content: string }).content)).toMatch(/answer: Too big|answer:.*100|<=10/i);
      expect((await calls()).map((c) => c.purpose).sort()).toEqual(["classify", "repair"]);

      const bad = fakeMessages(() => ({ parsed: { answer: "nope" } }));
      await expect(new LlmClient(db, bad.api).structured(req)).rejects.toBeInstanceOf(LlmOutputError);
      expect(bad.calls).toHaveLength(2);
    });

    it("treats a refusal as an error but still logs the billed call", async () => {
      const f = fakeMessages(() => ({ parsed: null, stop: "refusal" }));
      await expect(new LlmClient(db, f.api).structured(req)).rejects.toBeInstanceOf(LlmStopError);
      expect(await calls()).toHaveLength(1);
    });

    it("refuses to call a model with no configured price", async () => {
      const f = fakeMessages(() => ({ parsed: { answer: 1 } }));
      await expect(new LlmClient(db, f.api).structured({ ...req, model: "unpriced-model" })).rejects.toBeInstanceOf(MissingPriceError);
      expect(f.calls).toHaveLength(0);
    });

    it("stops at 100% of the daily budget, counted in the owner's timezone", async () => {
      await db.insert(schema.llmCalls).values({ purpose: "classify", model: MODEL, inputTokens: 1, outputTokens: 1, costUsd: "4.00000", latencyMs: 1 });
      const s = await budgetState(db);
      expect(s).toMatchObject({ limitUsd: 5, lowPriorityPaused: true, exhausted: false });
      await db.insert(schema.llmCalls).values({ purpose: "classify", model: MODEL, inputTokens: 1, outputTokens: 1, costUsd: "1.00000", latencyMs: 1 });
      const f = fakeMessages(() => ({ parsed: { answer: 1 } }));
      await expect(new LlmClient(db, f.api).structured(req)).rejects.toBeInstanceOf(BudgetExceededError);
      expect(f.calls).toHaveLength(0);
      // Spend from yesterday (owner time) doesn't count.
      await db.execute(sql`update llm_calls set created_at = now() - interval '2 days'`);
      expect((await budgetState(db)).exhausted).toBe(false);
    });
  });

  describe("classification", () => {
    it("builds a stable system prompt from DB tracks and watchlist", async () => {
      const t = await db.select().from(schema.tracks);
      const w = (await db.select().from(schema.watchlistEntities)).sort((a, b) => a.name.localeCompare(b.name));
      const p1 = buildSystemPrompt(loadPrompt("classify").text, { context: "ctx", organizations: ["Org"] }, t, w);
      const p2 = buildSystemPrompt(loadPrompt("classify").text, { context: "ctx", organizations: ["Org"] }, [...t].reverse(), w);
      expect(p1).toBe(p2);
      expect(p1).toContain("- indopacific_defense: Indo-Pacific & Defense.");
      expect(p1).toMatch(/- w\d+: StewardLens \(own_venture\)/);
      expect(p1).not.toContain("{{");
    });

    it("classifies, maps refs, filters unknown tracks, and adds keyword watchlist hits", async () => {
      const a = await addEvidence("Fixture: CFPB finalizes Section 1033 data rights rule");
      const b = await addEvidence("Fixture: unrelated item");
      await onlyThese([a, b]);
      const watch = (await db.select().from(schema.watchlistEntities)).sort((x, y) => x.name.localeCompare(y.name));
      const stewardRef = `w${watch.findIndex((w) => w.name === "StewardLens") + 1}`;
      const onvero = watch.find((w) => w.name === "Onvero")!;
      const onveroRef = `w${watch.indexOf(onvero) + 1}`;

      const { report, f } = await classifyAll((_ref, title) => title.includes("1033")
        ? { tracks: ["fintech_reg", "made_up_track"], watchlist_hits: [onveroRef, "w999"], relevance: 90 }
        : { is_noise: true });
      expect(report).toMatchObject({ batches: 1, classified: 2, missingFromOutput: 0 });
      expect(String((f.calls[0]!.messages[0] as { content: string }).content)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no UUIDs sent

      const [ca] = await db.select().from(schema.classifications).where(eq(schema.classifications.evidenceId, a));
      expect(ca!.tracks).toEqual(["fintech_reg"]);
      // model hit (Onvero) + keyword hit (StewardLens: "Section 1033"); unknown ref dropped
      expect(new Set(ca!.watchlistHits)).toEqual(new Set([onvero.id, watch.find((w) => w.name === "StewardLens")!.id]));
      expect(stewardRef).toMatch(/^w\d+$/);
      expect(ca).toMatchObject({ model: MODEL, promptVersion: "classify-v1", relevance: 90 });
      const [cb] = await db.select().from(schema.classifications).where(eq(schema.classifications.evidenceId, b));
      expect(cb!.isNoise).toBe(true);
      expect(await calls()).toHaveLength(1);
    });

    it("leaves items the model omitted unclassified, without looping", async () => {
      const a = await addEvidence("Fixture: kept");
      const b = await addEvidence("Fixture: omitted");
      await onlyThese([a, b]);
      const f = fakeMessages((p) => ({ parsed: echoClassifier()(p).parsed && { items: (echoClassifier()(p).parsed as { items: { id: string }[] }).items.filter((i) => i.id === "e1") } }));
      const report = await classifyPending(db, new LlmClient(db, f.api), { model: MODEL });
      expect(report).toMatchObject({ classified: 1, missingFromOutput: 1, batches: 1 });
      expect(f.calls).toHaveLength(1);
    });

    it("records failed batches in audit_events and keeps going", async () => {
      const a = await addEvidence("Fixture: will fail");
      await onlyThese([a]);
      const f = fakeMessages(() => ({ parsed: { wrong: true } }));
      const report = await classifyPending(db, new LlmClient(db, f.api), { model: MODEL });
      expect(report).toMatchObject({ failedBatches: 1, classified: 0 });
      const [audit] = await db.select().from(schema.auditEvents);
      expect(audit).toMatchObject({ action: "classify.batch_failed" });
    });

    it("skips low-priority sources at 80% of budget and stops at 100%", async () => {
      const normal = await addEvidence("Fixture: normal source");
      const low = await addEvidence("Fixture: low source", { low: true });
      await onlyThese([normal, low]);
      await db.insert(schema.llmCalls).values({ purpose: "classify", model: MODEL, inputTokens: 1, outputTokens: 1, costUsd: "4.10000", latencyMs: 1 });
      const r1 = await classifyAll();
      expect(r1.report).toMatchObject({ classified: 1, lowPriorityPaused: true });
      expect((await db.select().from(schema.classifications).where(eq(schema.classifications.evidenceId, low)))).toHaveLength(0);

      await db.insert(schema.llmCalls).values({ purpose: "classify", model: MODEL, inputTokens: 1, outputTokens: 1, costUsd: "1.00000", latencyMs: 1 });
      const r2 = await classifyAll();
      expect(r2.report).toMatchObject({ stoppedForBudget: true, classified: 0 });
      expect(r2.f.calls).toHaveLength(0);
    });

    it("batches at most 25 items per call", async () => {
      const ids = [];
      for (let i = 0; i < 27; i++) ids.push(await addEvidence(`Fixture batch item ${i}`));
      await onlyThese(ids);
      const { report, f } = await classifyAll();
      expect(report).toMatchObject({ batches: 2, classified: 27 });
      expect(f.calls).toHaveLength(2);
    });
  });

  describe("embeddings", () => {
    const unit = (i: number, j?: number, w = 0) => {
      const v = new Array<number>(DIM).fill(0);
      v[i] = 1;
      if (j !== undefined) v[j] = w;
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    };
    function fakeProvider(vectorFor: (text: string) => number[], dims = DIM): EmbeddingProvider & { calls: string[][] } {
      const calls: string[][] = [];
      return {
        name: "fixture", model: EMBED_MODEL, dimensions: DIM, calls,
        async embedDocuments(texts) {
          calls.push(texts);
          return { vectors: texts.map((t) => vectorFor(t).slice(0, dims)), totalTokens: texts.length * 10 };
        },
      };
    }
    async function classifyAs(id: string, c: { relevance: number; isNoise?: boolean; hits?: string[] }) {
      await db.insert(schema.classifications).values({ evidenceId: id, tracks: ["ai_tech"], geography: [], entities: [], topics: [], relevance: c.relevance, importance: 50, isNoise: c.isNoise ?? false, watchlistHits: c.hits ?? [], model: "fixture", promptVersion: "fixture" });
    }

    it("embeds only items that pass the gate, and logs the cost", async () => {
      const pass = await addEvidence("Fixture gate pass", { excerpt: "summary" });
      const low = await addEvidence("Fixture gate low");
      const hit = await addEvidence("Fixture gate watchlist");
      const noise = await addEvidence("Fixture gate noise");
      await classifyAs(pass, { relevance: 60 });
      await classifyAs(low, { relevance: 10 });
      await classifyAs(hit, { relevance: 10, hits: ["00000000-0000-0000-0000-000000000001"] });
      await classifyAs(noise, { relevance: 99, isNoise: true });

      let k = 0;
      const p = fakeProvider(() => unit(k++ % DIM));
      const r = await embedPending(db, new LlmClient(db, fakeMessages(() => ({ parsed: null })).api), p);
      expect(r).toMatchObject({ embedded: 2, duplicates: 0 });
      expect(p.calls.flat()).toEqual(expect.arrayContaining([embeddingText("Fixture gate pass", "summary"), "Fixture gate watchlist"]));
      expect(p.calls.flat()).toHaveLength(2);
      const [row] = await calls();
      expect(row).toMatchObject({ purpose: "embed", model: EMBED_MODEL, inputTokens: 20, outputTokens: 0 });
      expect(Number(row!.costUsd)).toBeCloseTo((20 * 0.06) / 1e6, 5);
    });

    it("marks near-duplicates from the same host within 48h, not across hosts", async () => {
      const t0 = new Date("2026-11-06T00:00:00Z");
      const older = await addEvidence("Fixture dup A", { host: "www.dup.example.invalid", publishedAt: t0 });
      const newer = await addEvidence("Fixture dup A (syndicated)", { host: "dup.example.invalid", publishedAt: new Date(t0.getTime() + 3_600_000) });
      const otherHost = await addEvidence("Fixture dup A elsewhere", { host: "other.example.invalid", publishedAt: new Date(t0.getTime() + 7_200_000) });
      const late = await addEvidence("Fixture dup A much later", { host: "dup.example.invalid", publishedAt: new Date(t0.getTime() + 72 * 3_600_000) });
      for (const id of [older, newer, otherHost, late]) await classifyAs(id, { relevance: 80 });
      await onlyThese([older, newer, otherHost, late]);

      const vecs: Record<string, number[]> = {
        "Fixture dup A": unit(5), "Fixture dup A (syndicated)": unit(5, 6, 0.1),
        "Fixture dup A elsewhere": unit(5), "Fixture dup A much later": unit(5),
      };
      const r = await embedPending(db, new LlmClient(db, fakeMessages(() => ({ parsed: null })).api), fakeProvider((t) => vecs[t]!));
      expect(r).toMatchObject({ embedded: 4, duplicates: 1 });
      const dups = await db.select().from(schema.evidenceDuplicates);
      expect(dups).toHaveLength(1);
      expect(dups[0]).toMatchObject({ evidenceId: newer, dupOfId: older });
      expect(dups[0]!.cosine).toBeGreaterThan(0.95);
    });

    it("rejects vectors of the wrong dimension without storing anything", async () => {
      const id = await addEvidence("Fixture wrong dims");
      await classifyAs(id, { relevance: 80 });
      await onlyThese([id]);
      await expect(embedPending(db, new LlmClient(db, fakeMessages(() => ({ parsed: null })).api), fakeProvider(() => unit(1), 10)))
        .rejects.toBeInstanceOf(EmbeddingDimensionError);
      expect(await db.select().from(schema.evidenceEmbeddings)).toHaveLength(0);
    });

    it("refuses to embed with an unpriced model", async () => {
      const p = { ...fakeProvider(() => unit(1)), model: "unpriced-embed" };
      await expect(embedPending(db, new LlmClient(db, fakeMessages(() => ({ parsed: null })).api), p)).rejects.toBeInstanceOf(MissingPriceError);
    });
  });
});
