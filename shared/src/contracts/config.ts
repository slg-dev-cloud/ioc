// zod contracts for config/sources.yaml and config/profile.yaml.
// Only `pnpm seed` reads these files (CLAUDE.md rule 9).
import { z } from "zod";

export const ConnectorTypeSchema = z.enum([
  "rss", "gdelt", "federal_register", "cfpb_complaints", "cpsc_recalls",
  "hn_algolia", "sam_gov", "cisa_kev", "html_page"]);
export const AccessMethodSchema = z.enum([
  "public_api", "public_feed", "licensed_api", "permitted_crawl", "manual_import"]);

export const SourceEntrySchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  connector_type: ConnectorTypeSchema,
  access_method: AccessMethodSchema,
  tracks: z.array(z.string()).min(1),
  cadence_minutes: z.number().int().positive(),
  is_primary: z.boolean().optional(),
  priority: z.enum(["normal", "low"]).optional(),
  enabled: z.boolean().optional(),
  terms_notes: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
}).strict();

export const SourcesFileSchema = z.object({
  defaults: z.object({
    enabled: z.boolean(),
    rate_limit_per_min: z.number().positive(),
  }),
  sources: z.array(SourceEntrySchema),
}).strict();

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const TrackSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string().min(1),
  priority: z.number().int(),
  max_findings: z.number().int().nonnegative(),
  description: z.string().min(1),
  keywords: z.array(z.string()).optional(),
}).strict();

export const WatchlistEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["own_venture", "competitor", "organization", "topic", "region"]),
  tracks: z.array(z.string()),
  keywords: z.array(z.string()).min(1),
  notes: z.string().optional(),
}).strict();

export const RankingSchema = z.object({
  relevance_gate: z.number().min(0).max(100),
  min_significance: z.number(),
  cluster_join_cosine: z.number().min(0).max(1),
  cluster_strong_cosine: z.number().min(0).max(1),
  weights: z.object({
    importance: z.number(),
    relevance: z.number(),
    per_distinct_source: z.number(),
    primary_source_bonus: z.number(),
    watchlist_bonus: z.number(),
    age_penalty_per_hour: z.number(),
  }).strict(),
}).strict();

// USD per million tokens. Cache prices default to 0.1x (read) and 1.25x (5-minute write) of input.
export const ModelPriceSchema = z.object({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cache_read_per_mtok: z.number().nonnegative().optional(),
  cache_write_per_mtok: z.number().nonnegative().optional(),
  source: z.string().optional(),
}).strict();
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const ProfileFileSchema = z.object({
  owner: z.object({
    name: z.string(),
    organizations: z.array(z.string()),
    timezone: z.string().min(1),
    brief_build_time: HHMM,
    brief_delivery_time: HHMM,
    context: z.string(),
  }).strict(),
  tracks: z.array(TrackSchema).min(1),
  watchlist: z.array(WatchlistEntrySchema),
  ranking: RankingSchema,
  budget: z.object({ daily_llm_usd: z.number().positive() }).strict(),
  model_pricing: z.record(z.string(), ModelPriceSchema).default({}),
}).strict();

export type SourcesFile = z.infer<typeof SourcesFileSchema>;
export type SourceEntry = z.infer<typeof SourceEntrySchema>;
export type ProfileFile = z.infer<typeof ProfileFileSchema>;
