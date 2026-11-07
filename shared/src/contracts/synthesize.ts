// Synthesis contract: docs/PHASE1_SPEC.md §7.3. Events and evidence are
// referenced by short refs (V1, E1) in the prompt and mapped back in code.
import { z } from "zod";

export const ClaimTypeSchema = z.enum(["fact", "allegation", "analysis", "forecast"]);
export const EvidenceRoleSchema = z.enum(["supports", "contradicts", "context"]);

export const SynthFindingSchema = z.object({
  event_id: z.string().describe("Event ref from the input, e.g. V2"),
  headline: z.string(),
  what_happened: z.string(),
  when_where: z.string(),
  why_it_matters: z.string(),
  who_affected: z.string(),
  implications: z.string(),
  consider_doing: z.string().nullable().describe("null unless an action follows from the evidence and the owner context"),
  watch_next: z.string(),
  claim_type: ClaimTypeSchema,
  confidence: z.number().int().min(0).max(100),
  confidence_rationale: z.string(),
  evidence: z.array(z.object({
    evidence_id: z.string().describe("Evidence ref from the input, e.g. E4"),
    role: EvidenceRoleSchema,
  })),
});

export const SynthesisOutputSchema = z.object({
  findings: z.array(SynthFindingSchema),
  nothing_material: z.boolean(),
});

export type SynthFinding = z.infer<typeof SynthFindingSchema>;
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;
