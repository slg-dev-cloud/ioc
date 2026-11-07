// Finding validator: docs/PHASE1_SPEC.md §7.3. Code, not an LLM. Mandatory and
// not bypassable (CLAUDE.md rule 3).
//
// Rejects a finding when:
//  1. any cited evidence ref is not in the supplied set or doesn't resolve in the DB
//  2. it has no `supports` evidence
//  4. confidence is outside 0–100 or the rationale is empty
//  - its event ref isn't one of the supplied events (or that event already has a finding)
// Downgrades `fact` to `allegation` (+ single_source) without >=2 supporting hosts or a primary source (3).
// Flags unsupported numbers (5) for one repair attempt.
import type { SynthFinding } from "@ioc/shared";
import { buildAllowedSet, unsupportedNumbers } from "./numbers.js";

export interface SuppliedEvidence {
  id: string;
  host: string;
  isPrimary: boolean;
  title: string;
  excerpt: string | null;
  publishedAt: Date | null;
}

export interface ValidationContext {
  events: Map<string, string>;            // event ref -> event id
  evidence: Map<string, SuppliedEvidence>; // evidence ref -> evidence
  resolvedIds: Set<string>;                // evidence ids that exist in the DB
  usedEvents: Set<string>;                 // event ids that already have a finding
  timeZone: string;
}

export interface ValidFinding {
  eventId: string;
  finding: SynthFinding;
  claimType: SynthFinding["claim_type"];
  singleSource: boolean;
  evidence: { evidenceId: string; role: "supports" | "contradicts" | "context" }[];
  notes: string[];
}

export type ValidationResult =
  | { status: "accepted"; value: ValidFinding }
  | { status: "rejected"; reasons: string[] }
  | { status: "unsupported_numbers"; issues: { field: string; values: number[] }[]; value: ValidFinding };

export const TEXT_FIELDS = [
  "headline", "what_happened", "when_where", "why_it_matters", "who_affected",
  "implications", "consider_doing", "watch_next", "confidence_rationale",
] as const;

export function validateFinding(f: SynthFinding, ctx: ValidationContext): ValidationResult {
  const reasons: string[] = [];

  const eventId = ctx.events.get(f.event_id);
  if (!eventId) reasons.push(`unknown event ref ${f.event_id}`);
  else if (ctx.usedEvents.has(eventId)) reasons.push(`event ${f.event_id} already has a finding`);

  // Rule 1: every citation resolves.
  const cited: { ref: string; ev: SuppliedEvidence; role: ValidFinding["evidence"][number]["role"] }[] = [];
  const seen = new Set<string>();
  for (const c of f.evidence) {
    const ev = ctx.evidence.get(c.evidence_id);
    if (!ev) {
      reasons.push(`evidence ref ${c.evidence_id} was not in the supplied set`);
      continue;
    }
    if (!ctx.resolvedIds.has(ev.id)) {
      reasons.push(`evidence ${ev.id} does not resolve in the database`);
      continue;
    }
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    cited.push({ ref: c.evidence_id, ev, role: c.role });
  }

  // Rule 2: at least one supporting item.
  const supports = cited.filter((c) => c.role === "supports");
  if (!supports.length) reasons.push("no supporting evidence");

  // Rule 4: confidence fields.
  if (!Number.isInteger(f.confidence) || f.confidence < 0 || f.confidence > 100) reasons.push(`confidence ${f.confidence} is outside 0-100`);
  if (!f.confidence_rationale.trim()) reasons.push("empty confidence rationale");

  for (const k of ["headline", "what_happened", "when_where", "why_it_matters", "who_affected", "implications", "watch_next"] as const) {
    if (!f[k].trim()) reasons.push(`empty ${k}`);
  }

  if (reasons.length) return { status: "rejected", reasons };

  // Rule 3: facts need two independent hosts or a primary source.
  const supportHosts = new Set(supports.map((s) => s.ev.host));
  const hasPrimary = supports.some((s) => s.ev.isPrimary);
  const notes: string[] = [];
  let claimType = f.claim_type;
  let singleSource = supportHosts.size < 2;
  if (claimType === "fact" && supportHosts.size < 2 && !hasPrimary) {
    claimType = "allegation";
    singleSource = true;
    notes.push("downgraded fact to allegation: fewer than 2 supporting hosts and no primary source");
  }

  const value: ValidFinding = {
    eventId: eventId!, finding: f, claimType, singleSource, notes,
    evidence: cited.map((c) => ({ evidenceId: c.ev.id, role: c.role })),
  };

  // Rule 5: numbers must appear in the cited items.
  const allowed = buildAllowedSet(
    cited.flatMap((c) => [c.ev.title, c.ev.excerpt]),
    cited.map((c) => c.ev.publishedAt),
    ctx.timeZone,
  );
  const issues: { field: string; values: number[] }[] = [];
  for (const field of TEXT_FIELDS) {
    const text = f[field];
    if (!text) continue;
    const bad = unsupportedNumbers(text, allowed);
    if (bad.length) issues.push({ field, values: bad });
  }
  if (issues.length) return { status: "unsupported_numbers", issues, value };

  return { status: "accepted", value };
}
