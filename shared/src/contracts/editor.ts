// Editor pass contract: docs/PHASE1_SPEC.md §7.4. Findings are referenced as F1..Fn.
import { z } from "zod";

const Linked = z.object({ text: z.string(), finding_ids: z.array(z.string()) });

export const EditorOutputSchema = z.object({
  executive_summary: z.string().describe("3-5 sentences; cite findings inline as [F:F2]"),
  most_consequential: z.array(z.string()).describe("Up to 3 finding refs"),
  cross_domain: z.array(Linked).describe("Only real linkages between findings in different tracks"),
  recommended_actions: z.array(Linked),
  watch_next: z.array(Linked),
});

export type EditorOutput = z.infer<typeof EditorOutputSchema>;
