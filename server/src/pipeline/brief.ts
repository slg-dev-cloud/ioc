// Brief build (spec §5 brief:build, §7.3, §7.4). Rendering and delivery are M6.
//
// 1. Window: previous build's window_end -> cutoff (default 24h).
// 2. Coverage from connector_runs (CLAUDE.md rule 5), never assumed.
// 3. Per track, in priority order: events active in the window at or above
//    min_significance, up to max_findings. An event goes to its highest-priority track only.
// 4. One synthesis call per track (MODEL_SYNTHESIZE); the code validator checks
//    every finding; unsupported numbers get one repair call, then the finding is dropped.
// 5. Editor pass; on failure a deterministic summary is used.
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { schema, EditorOutputSchema, SynthesisOutputSchema, type EditorOutput, type SynthFinding } from "@ioc/shared";
import { z } from "zod";
import type { Db } from "../db.js";
import { BudgetExceededError, budgetState } from "../llm/budget.js";
import { LlmOutputError, LlmStopError, type LlmClient } from "../llm/client.js";
import { loadPrompt } from "../llm/prompts.js";
import { getRanking, getSchedule, getSetting } from "../llm/settings.js";
import { zonedMidnight } from "./normalize.js";
import { buildAllowedSet, unsupportedNumbers } from "./numbers.js";
import { validateFinding, type SuppliedEvidence, type ValidFinding, type ValidationContext } from "./validator.js";
import { hostSql } from "./embed.js";

const { briefings, findings, findingEvidence, events, tracks, auditEvents } = schema;

export const MAX_EVIDENCE_PER_EVENT = 8;
const DEFAULT_WINDOW_MS = 24 * 3_600_000;
const OwnerSchema = z.object({ name: z.string(), organizations: z.array(z.string()), context: z.string() });

export interface BuildOptions {
  date: string;              // YYYY-MM-DD in the owner's timezone
  model: string;             // MODEL_SYNTHESIZE
  now?: Date;
  actor?: string;            // audit actor, e.g. "job:brief:build" or "owner"
  log?: (m: string, e?: Record<string, unknown>) => void;
}

export interface CoverageEntry {
  source_key: string;
  name: string;
  status: string;            // last run status in the window, or "not_run"
  runs: number;
  failed_runs: number;
  items_new: number;
  last_error: string | null;
}

export interface Coverage {
  sources: CoverageEntry[];
  budget: { spent_usd: number; limit_usd: number; stopped: boolean };
  tracks_skipped: { track: string; reason: string }[];
  editor_failed?: boolean;
  build_error?: string;
}

export interface BuildResult {
  briefingId: string;
  status: "validated" | "empty" | "failed";
  findings: number;
  rejected: number;
  windowStart: Date;
  windowEnd: Date;
}

export class BriefAlreadyDeliveredError extends Error {}

/** Window end: the build time on `date` in the owner's timezone, or now if that hasn't come yet. */
export function windowEndFor(date: string, buildTime: string, timeZone: string, now: Date): Date {
  const [hh, mm] = buildTime.split(":").map(Number);
  const cutoff = new Date(zonedMidnight(date, timeZone).getTime() + (hh! * 60 + mm!) * 60_000);
  return cutoff < now ? cutoff : now;
}

export async function buildBriefing(db: Db, llm: LlmClient, opts: BuildOptions): Promise<BuildResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const actor = opts.actor ?? "job:brief:build";
  const [schedule, ranking, owner] = await Promise.all([getSchedule(db), getRanking(db), getSetting(db, "owner", OwnerSchema)]);
  const tz = schedule.timezone;

  const windowEnd = windowEndFor(opts.date, schedule.brief_build_time, tz, now);
  const [prev] = await db.select({ windowEnd: briefings.windowEnd }).from(briefings)
    .where(and(eq(briefings.kind, "global"), lt(briefings.briefDate, opts.date), ne(briefings.status, "failed")))
    .orderBy(desc(briefings.briefDate)).limit(1);
  const windowStart = prev && prev.windowEnd < windowEnd ? prev.windowEnd : new Date(windowEnd.getTime() - DEFAULT_WINDOW_MS);

  // Replace an undelivered brief for the same date; never a delivered one.
  const [existing] = await db.select().from(briefings).where(and(eq(briefings.kind, "global"), eq(briefings.briefDate, opts.date)));
  if (existing) {
    if (existing.status === "delivered") throw new BriefAlreadyDeliveredError(`brief for ${opts.date} was already delivered`);
    await db.transaction(async (tx) => {
      const old = await tx.select({ id: findings.id }).from(findings).where(eq(findings.briefingId, existing.id));
      if (old.length) {
        await tx.delete(findingEvidence).where(inArray(findingEvidence.findingId, old.map((o) => o.id)));
        await tx.delete(findings).where(eq(findings.briefingId, existing.id));
      }
      await tx.delete(briefings).where(eq(briefings.id, existing.id));
      await tx.insert(auditEvents).values({ actor, action: "brief.replaced_draft", targetType: "briefing", targetId: existing.id, detail: { date: opts.date, status: existing.status } });
    });
  }

  const coverage: Coverage = {
    sources: await coverageFor(db, windowStart, windowEnd),
    budget: { spent_usd: 0, limit_usd: 0, stopped: false },
    tracks_skipped: [],
  };
  const [briefing] = await db.insert(briefings).values({
    kind: "global", briefDate: opts.date, timezone: tz, status: "draft", coverage, windowStart, windowEnd,
  }).returning({ id: briefings.id });
  const briefingId = briefing!.id;

  try {
    const { accepted, rejected } = await synthesizeTracks(db, llm, {
      briefingId, model: opts.model, windowStart, windowEnd, minSignificance: ranking.min_significance,
      ownerContext: ownerText(owner), tz, coverage, actor, log,
    });

    if (accepted.length) {
      const editor = await runEditor(db, llm, { model: opts.model, accepted, ownerContext: ownerText(owner), coverage, tz, log });
      coverage.editor_failed = editor.failed || undefined;
      await db.update(briefings).set({ executiveSummary: editor.summary, editor: editor.output }).where(eq(briefings.id, briefingId));
    }
    const b = await budgetState(db, now);
    coverage.budget = { spent_usd: round5(b.spentUsd), limit_usd: b.limitUsd, stopped: coverage.budget.stopped || b.exhausted };
    const status = accepted.length ? "validated" : "empty";
    await db.update(briefings).set({ status, coverage }).where(eq(briefings.id, briefingId));
    log("brief built", { status, findings: accepted.length, rejected });
    return { briefingId, status, findings: accepted.length, rejected, windowStart, windowEnd };
  } catch (err) {
    coverage.build_error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await db.update(briefings).set({ status: "failed", coverage }).where(eq(briefings.id, briefingId));
    await db.insert(auditEvents).values({ actor, action: "brief.failed", targetType: "briefing", targetId: briefingId, detail: { error: coverage.build_error } });
    return { briefingId, status: "failed", findings: 0, rejected: 0, windowStart, windowEnd };
  }
}

function ownerText(o: z.infer<typeof OwnerSchema>): string {
  return `${o.context.trim()} Organizations: ${o.organizations.join(", ")}.`;
}
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

export async function coverageFor(db: Db, start: Date, end: Date): Promise<CoverageEntry[]> {
  const res = await db.execute(sql`
    select s.key, s.name,
      (select r.status from connector_runs r where r.source_id = s.id and r.started_at >= ${start.toISOString()}::timestamptz and r.started_at < ${end.toISOString()}::timestamptz order by r.started_at desc limit 1) as last_status,
      (select r.error from connector_runs r where r.source_id = s.id and r.started_at >= ${start.toISOString()}::timestamptz and r.started_at < ${end.toISOString()}::timestamptz order by r.started_at desc limit 1) as last_error,
      (select count(*)::int from connector_runs r where r.source_id = s.id and r.started_at >= ${start.toISOString()}::timestamptz and r.started_at < ${end.toISOString()}::timestamptz) as runs,
      (select count(*)::int from connector_runs r where r.source_id = s.id and r.started_at >= ${start.toISOString()}::timestamptz and r.started_at < ${end.toISOString()}::timestamptz and r.status <> 'active') as failed_runs,
      (select coalesce(sum(r.items_new), 0)::int from connector_runs r where r.source_id = s.id and r.started_at >= ${start.toISOString()}::timestamptz and r.started_at < ${end.toISOString()}::timestamptz) as items_new
    from sources s where s.enabled order by s.key`);
  return (res.rows as { key: string; name: string; last_status: string | null; last_error: string | null; runs: number; failed_runs: number; items_new: number }[])
    .map((r) => ({
      source_key: r.key, name: r.name, status: r.last_status ?? "not_run", runs: r.runs,
      failed_runs: r.failed_runs, items_new: r.items_new, last_error: r.last_error,
    }));
}

interface Accepted { findingId: string; track: string; trackTitle: string; v: ValidFinding; evidence: SuppliedEvidence[] }

async function synthesizeTracks(db: Db, llm: LlmClient, a: {
  briefingId: string; model: string; windowStart: Date; windowEnd: Date; minSignificance: number;
  ownerContext: string; tz: string; coverage: Coverage; actor: string; log: (m: string, e?: Record<string, unknown>) => void;
}): Promise<{ accepted: Accepted[]; rejected: number }> {
  const prompt = loadPrompt("synthesize");
  const trackRows = await db.select().from(tracks).where(eq(tracks.enabled, true)).orderBy(asc(tracks.priority), asc(tracks.id));
  const activeEvents = await db.select().from(events).where(and(
    ne(events.status, "stale"),
    sql`${events.significance} >= ${a.minSignificance}`,
    sql`${events.lastSeenAt} >= ${a.windowStart.toISOString()}::timestamptz`,
    sql`${events.firstSeenAt} <= ${a.windowEnd.toISOString()}::timestamptz`,
  )).orderBy(desc(events.significance), asc(events.id));

  // Each event belongs to its highest-priority track.
  const byTrack = new Map<string, typeof activeEvents>();
  for (const ev of activeEvents) {
    const t = trackRows.find((tr) => ev.tracks.includes(tr.id));
    if (!t) continue;
    byTrack.set(t.id, [...(byTrack.get(t.id) ?? []), ev]);
  }

  const accepted: Accepted[] = [];
  let rejected = 0;
  const usedEvents = new Set<string>();

  for (const track of trackRows) {
    const selected = (byTrack.get(track.id) ?? []).slice(0, track.maxFindings);
    if (!selected.length) continue;

    // Build refs.
    const eventRefs = new Map<string, string>();
    const evidenceRefs = new Map<string, SuppliedEvidence>();
    const blocks: string[] = [];
    let e = 0;
    for (const [i, ev] of selected.entries()) {
      const ref = `V${i + 1}`;
      eventRefs.set(ref, ev.id);
      const items = await eventEvidenceFor(db, ev.id);
      const lines = items.map((it) => {
        const eref = `E${++e}`;
        evidenceRefs.set(eref, it);
        return JSON.stringify({
          evidence_id: eref, source_name: it.sourceName, is_primary: it.isPrimary, host: it.host,
          published_at: it.publishedAt?.toISOString() ?? null, title: it.title, excerpt: it.excerpt, url: it.url,
        });
      });
      blocks.push(`Event ${ref} (sources: ${ev.distinctSources}${ev.hasPrimarySource ? ", includes a primary source" : ""}):\n${lines.join("\n")}`);
    }
    const system = prompt.text
      .replace("{{OWNER_CONTEXT}}", a.ownerContext)
      .replace("{{TRACK_TITLE}}", track.title)
      .replace("{{TRACK_DESCRIPTION}}", track.description);
    const user = `Events for this track, most significant first:\n\n${blocks.join("\n\n")}`;

    let out: SynthFinding[];
    try {
      const res = await llm.structured({
        purpose: "synthesize", model: a.model, system, user, schema: SynthesisOutputSchema,
        maxTokens: 16_000, effort: "high", runRef: `brief:${a.briefingId}:${track.id}`,
      });
      out = res.data.findings;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        a.coverage.budget.stopped = true;
        a.coverage.tracks_skipped.push({ track: track.id, reason: "budget" });
        break;
      }
      if (err instanceof LlmOutputError || err instanceof LlmStopError) {
        a.coverage.tracks_skipped.push({ track: track.id, reason: err.message });
        await db.insert(auditEvents).values({ actor: a.actor, action: "synthesis.track_failed", targetType: "briefing", targetId: a.briefingId, detail: { track: track.id, error: err.message } });
        continue;
      }
      throw err;
    }

    const resolved = new Set((await db.execute(sql`select id from evidence_records where id in (${sql.join([...evidenceRefs.values()].map((x) => sql`${x.id}::uuid`), sql`, `)})`)).rows.map((r) => (r as { id: string }).id));
    const ctx: ValidationContext = { events: eventRefs, evidence: evidenceRefs, resolvedIds: resolved, usedEvents, timeZone: a.tz };

    const good: ValidFinding[] = [];
    const needsRepair: { f: SynthFinding; issues: { field: string; values: number[] }[] }[] = [];
    for (const f of out) {
      const r = validateFinding(f, ctx);
      if (r.status === "accepted") {
        good.push(r.value);
        usedEvents.add(r.value.eventId);
      } else if (r.status === "unsupported_numbers") {
        needsRepair.push({ f, issues: r.issues });
      } else {
        rejected++;
        await rejectAudit(db, a, track.id, f, r.reasons);
      }
    }

    if (needsRepair.length) {
      const repairUser = `${user}\n\nThese findings stated numbers that do not appear in their cited evidence. Rewrite only these findings, removing or correcting those numbers. Keep the same event refs.\n` +
        needsRepair.map((n) => `- ${n.f.event_id} "${n.f.headline}": ${n.issues.map((i) => `${i.field} has ${i.values.join(", ")}`).join("; ")}`).join("\n");
      let repaired: SynthFinding[] = [];
      try {
        repaired = (await llm.structured({
          purpose: "repair", model: a.model, system, user: repairUser, schema: SynthesisOutputSchema,
          maxTokens: 16_000, effort: "high", runRef: `brief:${a.briefingId}:${track.id}:numbers`,
        })).data.findings;
      } catch (err) {
        if (err instanceof BudgetExceededError) a.coverage.budget.stopped = true;
        else if (!(err instanceof LlmOutputError || err instanceof LlmStopError)) throw err;
      }
      for (const n of needsRepair) {
        const fixed = repaired.find((r) => r.event_id === n.f.event_id);
        const r = fixed ? validateFinding(fixed, ctx) : null;
        if (r?.status === "accepted") {
          good.push(r.value);
          usedEvents.add(r.value.eventId);
        } else {
          rejected++;
          const reasons = r?.status === "rejected" ? r.reasons
            : (r?.status === "unsupported_numbers" ? r.issues : n.issues).map((i) => `unsupported numbers in ${i.field}: ${i.values.join(", ")}`);
          await rejectAudit(db, a, track.id, fixed ?? n.f, reasons.length ? reasons : ["repair returned no finding for this event"]);
        }
      }
    }

    // Rank within the track by event significance.
    const order = new Map(selected.map((ev, i) => [ev.id, i]));
    good.sort((x, y) => order.get(x.eventId)! - order.get(y.eventId)!);
    for (const [rank, v] of good.entries()) {
      const findingId = await storeFinding(db, a.briefingId, track.id, rank + 1, v, a.model, prompt.version);
      if (v.notes.length) await db.insert(auditEvents).values({ actor: a.actor, action: "finding.adjusted", targetType: "finding", targetId: findingId, detail: { notes: v.notes } });
      accepted.push({
        findingId, track: track.id, trackTitle: track.title, v,
        evidence: v.evidence.map((x) => [...evidenceRefs.values()].find((s) => s.id === x.evidenceId)!),
      });
    }
    a.log("track synthesized", { track: track.id, events: selected.length, accepted: good.length });
  }
  return { accepted, rejected };
}

async function rejectAudit(db: Db, a: { actor: string; briefingId: string }, track: string, f: SynthFinding, reasons: string[]) {
  await db.insert(auditEvents).values({
    actor: a.actor, action: "finding.rejected", targetType: "briefing", targetId: a.briefingId,
    detail: { track, event_ref: f.event_id, headline: f.headline, reasons },
  });
}

type EventItem = SuppliedEvidence & { sourceName: string; url: string };

/** Up to 8 non-duplicate items per event: primary sources first, then newest. */
async function eventEvidenceFor(db: Db, eventId: string): Promise<EventItem[]> {
  const res = await db.execute(sql`
    select e.id, e.title, e.excerpt, e.published_at, e.canonical_url, s.name as source_name, s.is_primary,
           ${hostSql(sql`e.canonical_url`)} as host
    from event_evidence x
    join evidence_records e on e.id = x.evidence_id
    join sources s on s.id = e.source_id
    where x.event_id = ${eventId}
      and not exists (select 1 from evidence_duplicates d where d.evidence_id = e.id)
    order by s.is_primary desc, coalesce(e.published_at, e.retrieved_at) desc, e.id
    limit ${MAX_EVIDENCE_PER_EVENT}`);
  return (res.rows as { id: string; title: string; excerpt: string | null; published_at: string | Date | null; canonical_url: string; source_name: string; is_primary: boolean; host: string }[])
    .map((r) => ({
      id: r.id, title: r.title, excerpt: r.excerpt, publishedAt: r.published_at ? new Date(r.published_at) : null,
      url: r.canonical_url, sourceName: r.source_name, isPrimary: r.is_primary, host: r.host,
    }));
}

async function storeFinding(db: Db, briefingId: string, track: string, rank: number, v: ValidFinding, model: string, promptVersion: string): Promise<string> {
  const f = v.finding;
  return db.transaction(async (tx) => {
    const supportIds = v.evidence.filter((e) => e.role === "supports").map((e) => e.evidenceId);
    const hitsRes = supportIds.length ? await tx.execute(sql`
      select distinct unnest(watchlist_hits)::text as id from classifications
      where evidence_id in (${sql.join(supportIds.map((id) => sql`${id}::uuid`), sql`, `)})`) : { rows: [] };
    const [row] = await tx.insert(findings).values({
      briefingId, eventId: v.eventId, track, rank,
      headline: f.headline, whatHappened: f.what_happened, whenWhere: f.when_where, whyItMatters: f.why_it_matters,
      whoAffected: f.who_affected, implications: f.implications, considerDoing: f.consider_doing, watchNext: f.watch_next,
      claimType: v.claimType, singleSource: v.singleSource, confidence: f.confidence, confidenceRationale: f.confidence_rationale,
      watchlistHits: (hitsRes.rows as { id: string }[]).map((r) => r.id),
      model, promptVersion,
    }).returning({ id: findings.id });
    await tx.insert(findingEvidence).values(v.evidence.map((e) => ({ findingId: row!.id, evidenceId: e.evidenceId, role: e.role })));
    return row!.id;
  });
}

// ---------- Editor pass (§7.4) ----------

export interface StoredEditor {
  prompt_version: string | null;
  failed: boolean;
  most_consequential: string[];
  cross_domain: { text: string; finding_ids: string[] }[];
  recommended_actions: { text: string; finding_ids: string[] }[];
  watch_next: { text: string; finding_ids: string[] }[];
  dropped: string[];
}

const CITE_RE = /\[F:(F\d+)\]/g;

export function deterministicSummary(acc: { findingId: string; v: ValidFinding }[]): string {
  const top = acc.slice(0, 3).map((a) => `${a.v.finding.headline.replace(/\.$/, "")} [F:${a.findingId}].`);
  return `Top developments: ${top.join(" ")}`;
}

async function runEditor(db: Db, llm: LlmClient, a: {
  model: string; accepted: Accepted[]; ownerContext: string; coverage: Coverage; tz: string; log: (m: string, e?: Record<string, unknown>) => void;
}): Promise<{ summary: string; output: StoredEditor; failed: boolean }> {
  const prompt = loadPrompt("editor");
  const refToId = new Map(a.accepted.map((x, i) => [`F${i + 1}`, x.findingId]));
  const allowedFor = (refs: string[]) => {
    const items = a.accepted.filter((x, i) => refs.includes(`F${i + 1}`));
    const pool = items.length ? items : a.accepted;
    return buildAllowedSet(pool.flatMap((x) => x.evidence.flatMap((e) => [e.title, e.excerpt])), pool.flatMap((x) => x.evidence.map((e) => e.publishedAt)), a.tz);
  };
  const fallback = (failed: boolean, dropped: string[] = []) => ({
    summary: deterministicSummary(a.accepted),
    output: { prompt_version: failed ? null : prompt.version, failed, most_consequential: a.accepted.slice(0, 3).map((x) => x.findingId), cross_domain: [], recommended_actions: [], watch_next: [], dropped },
    failed,
  });

  const failedSources = a.coverage.sources.filter((s) => s.status !== "active");
  const user = [
    "Findings:",
    ...a.accepted.map((x, i) => JSON.stringify({
      ref: `F${i + 1}`, track: x.trackTitle, headline: x.v.finding.headline, what_happened: x.v.finding.what_happened,
      why_it_matters: x.v.finding.why_it_matters, implications: x.v.finding.implications, consider_doing: x.v.finding.consider_doing,
      watch_next: x.v.finding.watch_next, claim_type: x.v.claimType, confidence: x.v.finding.confidence,
    })),
    "",
    `Coverage: ${a.coverage.sources.length - failedSources.length} of ${a.coverage.sources.length} sources collected successfully in the window.` +
      (failedSources.length ? ` Limited or failed: ${failedSources.map((s) => `${s.name} (${s.status})`).join(", ")}.` : "") +
      (a.coverage.budget.stopped ? " The daily LLM budget stopped processing early." : "") +
      (a.coverage.tracks_skipped.length ? ` Tracks skipped: ${a.coverage.tracks_skipped.map((t) => t.track).join(", ")}.` : ""),
  ].join("\n");

  let out: EditorOutput;
  try {
    out = (await llm.structured({
      purpose: "edit", model: a.model, system: prompt.text.replace("{{OWNER_CONTEXT}}", a.ownerContext), user,
      schema: EditorOutputSchema, maxTokens: 8_000, effort: "medium",
    })).data;
  } catch (err) {
    a.log("editor pass failed; using deterministic summary", { error: err instanceof Error ? err.message : String(err) });
    if (err instanceof BudgetExceededError) a.coverage.budget.stopped = true;
    return fallback(true);
  }

  const dropped: string[] = [];
  const validRefs = (refs: string[]) => refs.length > 0 && refs.every((r) => refToId.has(r));
  const numbersOk = (text: string, refs: string[]) => unsupportedNumbers(text, allowedFor(refs)).length === 0;

  // Executive summary: every cited ref must exist and every number must be in the cited findings' evidence.
  const summaryRefs = [...out.executive_summary.matchAll(CITE_RE)].map((m) => m[1]!);
  let summary: string;
  if (summaryRefs.every((r) => refToId.has(r)) && numbersOk(out.executive_summary, summaryRefs)) {
    summary = out.executive_summary.replace(CITE_RE, (_, r: string) => `[F:${refToId.get(r)}]`);
  } else {
    dropped.push("executive_summary");
    summary = deterministicSummary(a.accepted);
  }

  const linked = (name: string, list: { text: string; finding_ids: string[] }[]) => list.flatMap((item, i) => {
    if (validRefs(item.finding_ids) && numbersOk(item.text, item.finding_ids)) {
      return [{ text: item.text.replace(CITE_RE, (_, r: string) => `[F:${refToId.get(r) ?? r}]`), finding_ids: item.finding_ids.map((r) => refToId.get(r)!) }];
    }
    dropped.push(`${name}[${i}]`);
    return [];
  });

  return {
    summary,
    failed: false,
    output: {
      prompt_version: prompt.version,
      failed: false,
      most_consequential: out.most_consequential.filter((r) => refToId.has(r)).slice(0, 3).map((r) => refToId.get(r)!),
      cross_domain: linked("cross_domain", out.cross_domain),
      recommended_actions: linked("recommended_actions", out.recommended_actions),
      watch_next: linked("watch_next", out.watch_next),
      dropped,
    },
  };
}

/** For the dry run: every cited evidence id of a briefing resolves (M5 acceptance). */
export async function citationReport(db: Db, briefingId: string) {
  const res = await db.execute(sql`
    select count(*)::int as cited, count(e.id)::int as resolved
    from findings f join finding_evidence fe on fe.finding_id = f.id
    left join evidence_records e on e.id = fe.evidence_id
    where f.briefing_id = ${briefingId}`);
  const r = res.rows[0] as { cited: number; resolved: number };
  return { cited: r.cited, resolved: r.resolved, allResolve: r.cited === r.resolved };
}

