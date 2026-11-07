// End-to-end brief build (M5) with a fake synthesis model against the real
// test database. Checks the M5 acceptance property: every citation resolves.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ioc/shared";
import type { Db } from "../src/db.js";
import { LlmClient, type MessagesApi } from "../src/llm/client.js";
import { BriefAlreadyDeliveredError, buildBriefing, citationReport, windowEndFor } from "../src/pipeline/brief.js";
import { loadConfig, seed } from "../src/seed.js";
import { freshDb, testDbUrl } from "./helpers/db.js";

const MODEL = "claude-sonnet-5-5";
const DATE = "2026-11-07";
// 07:10 JST on Nov 7 = 22:10 UTC Nov 6
const CUTOFF = new Date("2026-11-06T22:10:00Z");
const NOW = new Date("2026-11-06T23:00:00Z");

type Params = Parameters<MessagesApi["parse"]>[0];
const userText = (p: Params) => String((p.messages[0] as { content: string }).content);
const systemText = (p: Params) => (p.system as { text: string }[])[0]!.text;

/** Parses "Event V1 ..." blocks and their E-refs from a synthesis prompt. */
function eventsIn(p: Params): { ref: string; evidence: { ref: string; title: string; excerpt: string | null; host: string }[] }[] {
  const out: { ref: string; evidence: { ref: string; title: string; excerpt: string | null; host: string }[] }[] = [];
  for (const line of userText(p).split("\n")) {
    const m = /^Event (V\d+)/.exec(line);
    if (m) out.push({ ref: m[1]!, evidence: [] });
    else if (line.startsWith("{") && out.length) {
      const j = JSON.parse(line) as { evidence_id: string; title: string; excerpt: string | null; host: string };
      out.at(-1)!.evidence.push({ ref: j.evidence_id, title: j.title, excerpt: j.excerpt, host: j.host });
    }
  }
  return out;
}

function goodFinding(ev: ReturnType<typeof eventsIn>[number], o: Record<string, unknown> = {}) {
  return {
    event_id: ev.ref, headline: `Fixture finding on ${ev.evidence[0]!.title}`, what_happened: "Fixture: the cited items report a development.",
    when_where: "Fixture location.", why_it_matters: "Fixture significance.", who_affected: "Fixture parties.", implications: "Fixture implications.",
    consider_doing: null, watch_next: "Fixture follow-up.", claim_type: "fact", confidence: 72, confidence_rationale: "Fixture rationale.",
    evidence: ev.evidence.map((e) => ({ evidence_id: e.ref, role: "supports" })), ...o,
  };
}

interface Script {
  synth?: (p: Params, evs: ReturnType<typeof eventsIn>, track: string) => unknown;
  repair?: (p: Params, evs: ReturnType<typeof eventsIn>) => unknown;
  editor?: (p: Params) => unknown;
}

function fakeModel(script: Script = {}) {
  const calls: { kind: string; params: Params }[] = [];
  const api: MessagesApi = {
    async parse(p) {
      const sys = systemText(p);
      let parsed: unknown;
      let kind: string;
      if (sys.includes("editor of a private daily intelligence brief")) {
        kind = "editor";
        const refs = [...userText(p).matchAll(/"ref":"(F\d+)"/g)].map((m) => m[1]!);
        parsed = script.editor ? script.editor(p) : {
          executive_summary: `Fixture summary of today [F:${refs[0]}].`, most_consequential: refs.slice(0, 3),
          cross_domain: [], recommended_actions: [{ text: "Fixture action.", finding_ids: [refs[0]] }], watch_next: [],
        };
      } else {
        const track = /Track: (.*)/.exec(sys)![1]!;
        const evs = eventsIn(p);
        const isRepair = userText(p).includes("stated numbers that do not appear");
        kind = isRepair ? "repair" : `synth:${track}`;
        parsed = isRepair && script.repair ? script.repair(p, evs)
          : script.synth ? script.synth(p, evs, track)
          : { findings: evs.map((e) => goodFinding(e)), nothing_material: false };
      }
      calls.push({ kind, params: p });
      return { content: [], stop_reason: "end_turn", parsed_output: parsed, usage: { input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never };
    },
  };
  return { api, calls };
}

describe("windowEndFor", () => {
  it("uses the build time in the owner's timezone, or now if earlier", () => {
    expect(windowEndFor(DATE, "07:10", "Asia/Tokyo", NOW).toISOString()).toBe(CUTOFF.toISOString());
    const early = new Date("2026-11-06T20:00:00Z");
    expect(windowEndFor(DATE, "07:10", "Asia/Tokyo", early)).toEqual(early);
  });
});

describe.skipIf(!testDbUrl)("brief build (M5)", () => {
  let db: Db;
  let end: () => Promise<void>;
  let press: string, press2: string, gov: string;
  let n = 0;

  beforeAll(async () => {
    ({ db, end } = await freshDb());
    await seed(db, loadConfig());
    const mk = async (key: string, primary: boolean) => (await db.insert(schema.sources).values({ key, name: `Fixture ${key} (test only)`, connectorType: "rss", accessMethod: "public_feed", isPrimary: primary, tracks: ["ai_tech"], config: {}, cadenceMinutes: 60, enabled: true }).returning())[0]!.id;
    press = await mk("fixture-press-a", false);
    press2 = await mk("fixture-press-b", false);
    gov = await mk("fixture-gov", true);
  });
  afterAll(() => end?.());
  beforeEach(async () => {
    await db.execute(sql`truncate finding_evidence, findings, briefings, event_evidence, events, llm_calls, audit_events, connector_runs cascade`);
    await db.execute(sql`update sources set enabled = false where key not like 'fixture-%'`);
  });

  async function evidence(sourceId: string, title: string, excerpt: string | null, host: string, hits: string[] = []) {
    const id = ++n;
    const [e] = await db.insert(schema.evidenceRecords).values({ sourceId, canonicalUrl: `https://${host}/fixture-${id}`, title, excerpt, publishedAt: new Date("2026-11-06T12:00:00Z"), fingerprint: `fixture-brief-${id}-${Math.random()}`, collectionMethod: "scheduled" }).returning();
    await db.insert(schema.classifications).values({ evidenceId: e!.id, tracks: ["ai_tech"], geography: [], entities: [], topics: [], relevance: 70, importance: 60, isNoise: false, watchlistHits: hits, model: "fixture", promptVersion: "fixture" });
    return e!.id;
  }
  async function event(title: string, trackIds: string[], significance: number, members: string[], o: { status?: "developing" | "confirmed" | "stale"; lastSeenAt?: Date } = {}) {
    const [ev] = await db.insert(schema.events).values({ title, tracks: trackIds, status: o.status ?? "confirmed", firstSeenAt: new Date("2026-11-06T10:00:00Z"), lastSeenAt: o.lastSeenAt ?? new Date("2026-11-06T12:00:00Z"), distinctSources: 2, significance }).returning();
    await db.insert(schema.eventEvidence).values(members.map((m) => ({ eventId: ev!.id, evidenceId: m })));
    return ev!.id;
  }
  const build = (f: ReturnType<typeof fakeModel>, now = NOW) => buildBriefing(db, new LlmClient(db, f.api, () => now), { date: DATE, model: MODEL, now });
  const findingRows = async (briefingId: string) => db.select().from(schema.findings).where(eq(schema.findings.briefingId, briefingId));
  const audits = async (action: string) => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, action));

  it("builds a validated brief whose citations all resolve", async () => {
    const watch = (await db.select().from(schema.watchlistEntities))[0]!;
    const a1 = await evidence(press, "Fixture AI story A", "Outlet A says 12 agents launched.", "a.example.invalid", [watch.id]);
    const a2 = await evidence(press2, "Fixture AI story A follow-up", "Outlet B confirms 12 agents.", "b.example.invalid");
    const b1 = await evidence(gov, "Fixture fintech rule", "Agency publishes rule.", "gov.example.invalid");
    await event("Fixture AI event", ["ai_tech"], 80, [a1, a2]);
    await event("Fixture fintech event", ["fintech_reg"], 70, [b1]);

    const f = fakeModel();
    const r = await build(f);
    expect(r).toMatchObject({ status: "validated", findings: 2, rejected: 0 });
    expect(await citationReport(db, r.briefingId)).toEqual({ cited: 3, resolved: 3, allResolve: true });

    const rows = await findingRows(r.briefingId);
    const ai = rows.find((x) => x.track === "ai_tech")!;
    expect(ai).toMatchObject({ rank: 1, claimType: "fact", singleSource: false, model: MODEL, promptVersion: "synthesize-v1" });
    expect(ai.watchlistHits).toEqual([watch.id]);
    expect(rows.find((x) => x.track === "fintech_reg")).toMatchObject({ claimType: "fact", singleSource: true }); // primary source

    const [b] = await db.select().from(schema.briefings).where(eq(schema.briefings.id, r.briefingId));
    expect(b!.executiveSummary).toMatch(new RegExp(`\\[F:${rows.find((x) => x.track === "ai_tech")!.id}\\]`));
    expect(b!.editor).toMatchObject({ prompt_version: "editor-v1", failed: false });
    // Tracks run in priority order: ai_tech (2) before fintech_reg (3), then the editor.
    expect(f.calls.map((c) => c.kind)).toEqual(["synth:AI, Technology & Cyber", "synth:Fintech & Open Banking", "editor"]);
    // Synthesis sees refs, never UUIDs.
    expect(userText(f.calls[0]!.params)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("selects by window, significance, and status, and gives a multi-track event to its top track only", async () => {
    const x = await evidence(press, "Fixture both tracks", null, "a.example.invalid");
    const lowSig = await evidence(press, "Fixture low significance", null, "a.example.invalid");
    const stale = await evidence(press, "Fixture stale", null, "a.example.invalid");
    const old = await evidence(press, "Fixture outside window", null, "a.example.invalid");
    await event("both", ["economy", "ai_tech"], 90, [x]);
    await event("low", ["ai_tech"], 10, [lowSig]);
    await event("stale", ["ai_tech"], 90, [stale], { status: "stale" });
    await event("old", ["ai_tech"], 90, [old], { lastSeenAt: new Date("2026-11-04T00:00:00Z") });

    const f = fakeModel();
    const r = await build(f);
    expect(r.findings).toBe(1);
    expect(f.calls.filter((c) => c.kind.startsWith("synth"))).toHaveLength(1);
    expect((await findingRows(r.briefingId))[0]!.track).toBe("ai_tech");
  });

  it("caps findings per track at max_findings", async () => {
    for (let i = 0; i < 6; i++) await event(`cap ${i}`, ["ai_tech"], 60 + i, [await evidence(press, `Fixture cap ${i}`, null, "a.example.invalid")]);
    const f = fakeModel();
    await build(f);
    expect(eventsIn(f.calls[0]!.params)).toHaveLength(4); // ai_tech max_findings = 4
  });

  it("rejects bad citations and downgrades single-host facts, with audit records", async () => {
    const a = await evidence(press, "Fixture single host", null, "a.example.invalid");
    const b = await evidence(press, "Fixture bad cite", null, "a.example.invalid");
    await event("one", ["ai_tech"], 80, [a]);
    await event("two", ["ai_tech"], 70, [b]);
    const f = fakeModel({ synth: (_p, evs) => ({ nothing_material: false, findings: [
      goodFinding(evs[0]!),
      goodFinding(evs[1]!, { evidence: [{ evidence_id: "E99", role: "supports" }] }),
    ] }) });
    const r = await build(f);
    expect(r).toMatchObject({ findings: 1, rejected: 1 });
    expect((await findingRows(r.briefingId))[0]).toMatchObject({ claimType: "allegation", singleSource: true });
    expect((await audits("finding.rejected"))[0]!.detail).toMatchObject({ reasons: ["evidence ref E99 was not in the supplied set", "no supporting evidence"] });
    expect(await audits("finding.adjusted")).toHaveLength(1);
  });

  it("repairs unsupported numbers once, and drops findings that stay wrong", async () => {
    const a = await evidence(press, "Fixture numbers A", "Report cites 40 vessels.", "a.example.invalid");
    const b = await evidence(press2, "Fixture numbers B", "Report cites 7 drills.", "b.example.invalid");
    await event("numA", ["indopacific_defense"], 80, [a]);
    await event("numB", ["indopacific_defense"], 70, [b]);
    const f = fakeModel({
      synth: (_p, evs) => ({ nothing_material: false, findings: [
        goodFinding(evs[0]!, { what_happened: "Fixture: 45 vessels were seen." }),
        goodFinding(evs[1]!, { what_happened: "Fixture: 9 drills were held." }),
      ] }),
      repair: (_p, evs) => ({ nothing_material: false, findings: [
        goodFinding(evs[0]!, { what_happened: "Fixture: 40 vessels were seen." }),
        goodFinding(evs[1]!, { what_happened: "Fixture: 10 drills were held." }),
      ] }),
    });
    const r = await build(f);
    expect(r).toMatchObject({ findings: 1, rejected: 1 });
    expect((await findingRows(r.briefingId))[0]!.whatHappened).toBe("Fixture: 40 vessels were seen.");
    expect(f.calls.map((c) => c.kind)).toContain("repair");
    expect((await audits("finding.rejected"))[0]!.detail).toMatchObject({ reasons: ["unsupported numbers in what_happened: 10"] });
    expect((await db.select().from(schema.llmCalls)).map((c) => c.purpose)).toContain("repair");
  });

  it("falls back to a deterministic summary when the editor cites a missing finding or invents a number", async () => {
    await event("ed", ["ai_tech"], 80, [await evidence(press, "Fixture editor story", null, "a.example.invalid")]);
    const f = fakeModel({ editor: () => ({ executive_summary: "Fixture: 99 things happened [F:F7].", most_consequential: ["F1", "F9"], cross_domain: [], recommended_actions: [{ text: "Bad ref.", finding_ids: ["F5"] }], watch_next: [] }) });
    const r = await build(f);
    const [b] = await db.select().from(schema.briefings).where(eq(schema.briefings.id, r.briefingId));
    const [row] = await findingRows(r.briefingId);
    expect(b!.executiveSummary).toBe(`Top developments: Fixture finding on Fixture editor story [F:${row!.id}].`);
    expect(b!.editor).toMatchObject({ most_consequential: [row!.id], recommended_actions: [], dropped: ["executive_summary", "recommended_actions[0]"] });
  });

  it("still ships when the editor call fails entirely", async () => {
    await event("ed2", ["ai_tech"], 80, [await evidence(press, "Fixture editor failure", null, "a.example.invalid")]);
    const f = fakeModel({ editor: () => ({ not: "valid" }) });
    const r = await build(f);
    expect(r.status).toBe("validated");
    const [b] = await db.select().from(schema.briefings).where(eq(schema.briefings.id, r.briefingId));
    expect(b!.executiveSummary).toMatch(/^Top developments:/);
    expect(b!.coverage).toMatchObject({ editor_failed: true });
  });

  it("marks an empty day and makes no model calls", async () => {
    const f = fakeModel();
    const r = await build(f);
    expect(r).toMatchObject({ status: "empty", findings: 0 });
    expect(f.calls).toHaveLength(0);
  });

  it("reports coverage from connector_runs, never assumed", async () => {
    await db.insert(schema.connectorRuns).values([
      { sourceId: press, startedAt: new Date("2026-11-06T10:00:00Z"), finishedAt: new Date("2026-11-06T10:01:00Z"), status: "active", itemsFetched: 5, itemsNew: 3 },
      { sourceId: press2, startedAt: new Date("2026-11-06T11:00:00Z"), finishedAt: new Date("2026-11-06T11:01:00Z"), status: "rate_limited", error: "HTTP 429" },
      // outside the window: ignored
      { sourceId: gov, startedAt: new Date("2026-11-01T00:00:00Z"), finishedAt: new Date("2026-11-01T00:01:00Z"), status: "active", itemsNew: 9 },
    ]);
    const r = await build(fakeModel());
    const [b] = await db.select().from(schema.briefings).where(eq(schema.briefings.id, r.briefingId));
    const cov = (b!.coverage as { sources: { source_key: string; status: string; items_new: number; last_error: string | null }[] }).sources;
    expect(cov.find((s) => s.source_key === "fixture-press-a")).toMatchObject({ status: "active", items_new: 3 });
    expect(cov.find((s) => s.source_key === "fixture-press-b")).toMatchObject({ status: "rate_limited", last_error: "HTTP 429" });
    expect(cov.find((s) => s.source_key === "fixture-gov")).toMatchObject({ status: "not_run", items_new: 0 });
  });

  it("replaces an undelivered draft for the same date but never a delivered brief", async () => {
    await event("re", ["ai_tech"], 80, [await evidence(press, "Fixture rebuild", null, "a.example.invalid")]);
    const first = await build(fakeModel());
    const second = await build(fakeModel());
    expect(second.briefingId).not.toBe(first.briefingId);
    expect(await db.select().from(schema.briefings)).toHaveLength(1);
    expect(await audits("brief.replaced_draft")).toHaveLength(1);
    await db.update(schema.briefings).set({ status: "delivered" });
    await expect(build(fakeModel())).rejects.toBeInstanceOf(BriefAlreadyDeliveredError);
  });

  it("stops synthesis at the budget and notes it in coverage", async () => {
    await event("bud", ["ai_tech"], 80, [await evidence(press, "Fixture budget", null, "a.example.invalid")]);
    await db.insert(schema.llmCalls).values({ purpose: "classify", model: MODEL, inputTokens: 1, outputTokens: 1, costUsd: "5.00000", latencyMs: 1, createdAt: NOW });
    const f = fakeModel();
    const r = await build(f);
    expect(r.status).toBe("empty");
    expect(f.calls).toHaveLength(0);
    const [b] = await db.select().from(schema.briefings).where(eq(schema.briefings.id, r.briefingId));
    expect(b!.coverage).toMatchObject({ budget: { stopped: true }, tracks_skipped: [{ track: "ai_tech", reason: "budget" }] });
  });

  it("uses the previous brief's window end as the next window start", async () => {
    const prevEnd = new Date("2026-11-05T22:10:00Z");
    await db.insert(schema.briefings).values({ kind: "global", briefDate: "2026-11-06", timezone: "Asia/Tokyo", status: "delivered", coverage: {}, windowStart: new Date("2026-11-04T22:10:00Z"), windowEnd: prevEnd });
    const r = await build(fakeModel());
    expect(r.windowStart.toISOString()).toBe(prevEnd.toISOString());
    expect(r.windowEnd.toISOString()).toBe(CUTOFF.toISOString());
  });
});
