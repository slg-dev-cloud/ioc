// Validator and number check (spec §7.3): one test per rejection rule.
import { describe, expect, it } from "vitest";
import type { SynthFinding } from "@ioc/shared";
import { buildAllowedSet, dateNumbers, extractNumbers, unsupportedNumbers } from "../src/pipeline/numbers.js";
import { validateFinding, type SuppliedEvidence, type ValidationContext } from "../src/pipeline/validator.js";

describe("number check", () => {
  it("extracts values with separators, decimals, currency, percent, and scale words", () => {
    expect(extractNumbers("$5M, 1,200 users, 3.5% up, $2.3B, 12 billion yen")).toEqual([5e6, 5, 1200, 3.5, 2.3e9, 2.3, 12e9, 12]);
  });
  it("doesn't treat a spaced single letter as a scale", () => {
    expect(extractNumbers("5 m away")).toEqual([5]);
  });
  it("ignores digits glued to letters but keeps hyphenated designators", () => {
    expect(extractNumbers("B2B v2 F-35 COVID-19")).toEqual([35, 19]);
  });
  it("matches by value across formats", () => {
    const allowed = buildAllowedSet(["Regulator fines bank $5 million over 1,200 complaints"], [], "UTC");
    expect(unsupportedNumbers("A $5M fine over 1200 complaints", allowed)).toEqual([]);
    expect(unsupportedNumbers("5,000,000 dollars", allowed)).toEqual([]);
  });
  it("flags numbers not in the evidence, including a scaled claim over a bare number", () => {
    const allowed = buildAllowedSet(["5 ships sailed"], [], "UTC");
    expect(unsupportedNumbers("30% more", allowed)).toEqual([30]);
    expect(unsupportedNumbers("5 million", allowed)).toEqual([5e6]);
  });
  it("allows publication date parts in UTC and the owner's timezone", () => {
    // 2026-11-06T20:00Z is Nov 7 in Tokyo
    const nums = dateNumbers([new Date("2026-11-06T20:00:00Z")], "Asia/Tokyo");
    expect(nums).toEqual(expect.arrayContaining([2026, 11, 6, 7]));
    const allowed = buildAllowedSet([], [new Date("2026-11-06T20:00:00Z")], "Asia/Tokyo");
    expect(unsupportedNumbers("On Nov 7, 2026", allowed)).toEqual([]);
  });
});

const ev = (id: string, host: string, o: Partial<SuppliedEvidence> = {}): SuppliedEvidence => ({
  id, host, isPrimary: false, title: `Fixture title for ${id}`, excerpt: "Fixture excerpt mentions 42 units and $3 billion.", publishedAt: new Date("2026-11-06T00:00:00Z"), ...o,
});

function ctx(o: Partial<ValidationContext> = {}): ValidationContext {
  return {
    events: new Map([["V1", "event-1"]]),
    evidence: new Map([["E1", ev("id-1", "a.example.invalid")], ["E2", ev("id-2", "b.example.invalid")], ["E3", ev("id-3", "a.example.invalid")], ["E4", ev("id-4", "gov.example.invalid", { isPrimary: true })]]),
    resolvedIds: new Set(["id-1", "id-2", "id-3", "id-4"]),
    usedEvents: new Set(),
    timeZone: "Asia/Tokyo",
    ...o,
  };
}

function finding(o: Partial<SynthFinding> = {}): SynthFinding {
  return {
    event_id: "V1", headline: "Fixture headline", what_happened: "Fixture: 42 units were reported.", when_where: "Fixture place, November 2026.",
    why_it_matters: "Fixture significance.", who_affected: "Fixture parties.", implications: "Fixture implications.", consider_doing: null,
    watch_next: "Fixture follow-up.", claim_type: "fact", confidence: 70, confidence_rationale: "Two outlets agree.",
    evidence: [{ evidence_id: "E1", role: "supports" }, { evidence_id: "E2", role: "supports" }], ...o,
  };
}

describe("validateFinding", () => {
  it("accepts a well-supported fact", () => {
    const r = validateFinding(finding(), ctx());
    expect(r.status).toBe("accepted");
    if (r.status === "accepted") expect(r.value).toMatchObject({ eventId: "event-1", claimType: "fact", singleSource: false });
  });

  it("rule 1: rejects a ref outside the supplied set", () => {
    const r = validateFinding(finding({ evidence: [{ evidence_id: "E9", role: "supports" }, { evidence_id: "E1", role: "supports" }] }), ctx());
    expect(r).toEqual({ status: "rejected", reasons: ["evidence ref E9 was not in the supplied set"] });
  });

  it("rule 1: rejects evidence that doesn't resolve in the database", () => {
    const r = validateFinding(finding(), ctx({ resolvedIds: new Set(["id-1"]) }));
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reasons).toContain("evidence id-2 does not resolve in the database");
  });

  it("rule 2: rejects a finding with no supporting evidence", () => {
    const r = validateFinding(finding({ evidence: [{ evidence_id: "E1", role: "context" }] }), ctx());
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reasons).toContain("no supporting evidence");
  });

  it("rule 3: downgrades a single-host fact to an allegation", () => {
    const r = validateFinding(finding({ evidence: [{ evidence_id: "E1", role: "supports" }, { evidence_id: "E3", role: "supports" }] }), ctx());
    expect(r.status).toBe("accepted");
    if (r.status === "accepted") {
      expect(r.value).toMatchObject({ claimType: "allegation", singleSource: true });
      expect(r.value.notes[0]).toMatch(/downgraded fact to allegation/);
    }
  });

  it("rule 3: keeps a fact backed by one primary source, marked single source", () => {
    const r = validateFinding(finding({ evidence: [{ evidence_id: "E4", role: "supports" }] }), ctx());
    expect(r.status).toBe("accepted");
    if (r.status === "accepted") expect(r.value).toMatchObject({ claimType: "fact", singleSource: true });
  });

  it("rule 3: leaves non-fact claims alone", () => {
    const r = validateFinding(finding({ claim_type: "analysis", evidence: [{ evidence_id: "E1", role: "supports" }] }), ctx());
    if (r.status === "accepted") expect(r.value.claimType).toBe("analysis");
    else throw new Error(r.status);
  });

  it("rule 4: rejects out-of-range confidence and an empty rationale", () => {
    const r = validateFinding(finding({ confidence: 140, confidence_rationale: "  " }), ctx());
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reasons).toEqual(expect.arrayContaining(["confidence 140 is outside 0-100", "empty confidence rationale"]));
  });

  it("rule 5: flags numbers missing from the cited items, in any field", () => {
    const r = validateFinding(finding({ what_happened: "Fixture: 43 units were reported.", watch_next: "A vote on 15 December." }), ctx());
    expect(r.status).toBe("unsupported_numbers");
    if (r.status === "unsupported_numbers") expect(r.issues).toEqual([{ field: "what_happened", values: [43] }, { field: "watch_next", values: [15] }]);
  });

  it("rule 5: accepts numbers from cited excerpts and dates", () => {
    const r = validateFinding(finding({ what_happened: "Fixture: $3B for 42 units on Nov 6, 2026." }), ctx());
    expect(r.status).toBe("accepted");
  });

  it("rejects unknown events and a second finding for the same event", () => {
    expect(validateFinding(finding({ event_id: "V7" }), ctx()).status).toBe("rejected");
    expect(validateFinding(finding(), ctx({ usedEvents: new Set(["event-1"]) })).status).toBe("rejected");
  });
});
