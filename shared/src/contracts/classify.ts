// Classification contract: docs/PHASE1_SPEC.md §7.1.
// Items and watchlist entities are referenced by short refs (e1, w1) in the
// prompt; the classifier maps them back to UUIDs.
import { z } from "zod";

export const ClassifiedItemSchema = z.object({
  id: z.string().describe("The item ref from the input, e.g. e3"),
  tracks: z.array(z.string()).describe("Zero or more track ids from the track list"),
  geography: z.array(z.string()).describe("Countries or regions the item concerns"),
  entities: z.array(z.object({
    name: z.string(),
    type: z.enum(["organization", "person", "government", "product", "location", "other"]),
  })),
  topics: z.array(z.string()).describe("Short topic labels"),
  relevance: z.number().int().min(0).max(100).describe("Relevance to the owner profile, 0-100"),
  importance: z.number().int().min(0).max(100).describe("General significance regardless of the owner, 0-100"),
  is_noise: z.boolean(),
  watchlist_hits: z.array(z.string()).describe("Watchlist refs (e.g. w2) the item clearly touches"),
});

export const ClassificationOutputSchema = z.object({
  items: z.array(ClassifiedItemSchema),
});

export type ClassifiedItem = z.infer<typeof ClassifiedItemSchema>;
export type ClassificationOutput = z.infer<typeof ClassificationOutputSchema>;
