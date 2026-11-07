// Drizzle schema. Source of truth: docs/PHASE1_SPEC.md §3 (v1.1).
// Non-table objects (pgvector extension, append-only trigger) live in
// hand-written migrations under shared/drizzle/.
import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb, date,
  numeric, primaryKey, index, uniqueIndex, vector, real,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024);
const DIM = EMBEDDING_DIM;

export const connectorType = pgEnum("connector_type", [
  "rss", "gdelt", "federal_register", "cfpb_complaints", "cpsc_recalls",
  "hn_algolia", "sam_gov", "cisa_kev", "html_page"]);
export const accessMethod = pgEnum("access_method", [
  "public_api", "public_feed", "licensed_api", "permitted_crawl", "manual_import"]);
export const connectorStatus = pgEnum("connector_status", [
  "active", "limited", "auth_required", "rate_limited", "unavailable", "unsupported"]);
export const collectionMethod = pgEnum("collection_method", [
  "scheduled", "event", "research", "user"]);
export const claimType = pgEnum("claim_type", ["fact", "allegation", "analysis", "forecast"]);
export const findingStatus = pgEnum("finding_status", ["active", "revised", "retracted"]);
export const evidenceRole = pgEnum("evidence_role", ["supports", "contradicts", "context"]);
export const briefKind = pgEnum("brief_kind", ["global", "signals"]);
export const briefStatus = pgEnum("brief_status", ["draft", "validated", "delivered", "failed", "empty"]);
export const eventStatus = pgEnum("event_status", ["developing", "confirmed", "stale"]);

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  connectorType: connectorType("connector_type").notNull(),
  accessMethod: accessMethod("access_method").notNull(),
  tracks: text("tracks").array().notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  priority: text("priority").notNull().default("normal"), // normal | low
  config: jsonb("config").notNull(),
  cadenceMinutes: integer("cadence_minutes").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  termsNotes: text("terms_notes"),
  currentStatus: connectorStatus("current_status").notNull().default("unsupported"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Runtime collection state. The seed never writes this table.
export const sourceState = pgTable("source_state", {
  sourceId: uuid("source_id").primaryKey().references(() => sources.id),
  watermark: jsonb("watermark"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const connectorRuns = pgTable("connector_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => sources.id).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: connectorStatus("status").notNull(),
  itemsFetched: integer("items_fetched").notNull().default(0),
  itemsNew: integer("items_new").notNull().default(0),
  error: text("error"),
}, (t) => [index("runs_source_time").on(t.sourceId, t.startedAt)]);

// Immutable after insert: a trigger rejects UPDATE and DELETE (migration 0002).
export const evidenceRecords = pgTable("evidence_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => sources.id).notNull(),
  sourceItemId: text("source_item_id"),
  canonicalUrl: text("canonical_url").notNull(),
  title: text("title").notNull(),
  excerpt: text("excerpt"),
  contentText: text("content_text"),
  author: text("author"),
  language: text("language"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  eventOccurredAt: timestamp("event_occurred_at", { withTimezone: true }),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).defaultNow().notNull(),
  fingerprint: text("fingerprint").notNull(),
  collectionMethod: collectionMethod("collection_method").notNull(),
  permittedUse: text("permitted_use"),
}, (t) => [
  uniqueIndex("evidence_fingerprint").on(t.fingerprint),
  index("evidence_published").on(t.publishedAt),
]);

export const evidenceRaw = pgTable("evidence_raw", {
  evidenceId: uuid("evidence_id").primaryKey().references(() => evidenceRecords.id),
  raw: jsonb("raw").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const evidenceEmbeddings = pgTable("evidence_embeddings", {
  evidenceId: uuid("evidence_id").primaryKey().references(() => evidenceRecords.id),
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: DIM }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("evidence_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

export const evidenceDuplicates = pgTable("evidence_duplicates", {
  evidenceId: uuid("evidence_id").primaryKey().references(() => evidenceRecords.id),
  dupOfId: uuid("dup_of_id").references(() => evidenceRecords.id).notNull(),
  cosine: real("cosine").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const classifications = pgTable("classifications", {
  evidenceId: uuid("evidence_id").primaryKey().references(() => evidenceRecords.id),
  tracks: text("tracks").array().notNull(),
  geography: text("geography").array().notNull(),
  entities: jsonb("entities").notNull(),
  topics: text("topics").array().notNull(),
  relevance: integer("relevance").notNull(),
  importance: integer("importance").notNull(),
  isNoise: boolean("is_noise").notNull(),
  watchlistHits: uuid("watchlist_hits").array().notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  tracks: text("tracks").array().notNull(),
  status: eventStatus("status").notNull().default("developing"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  distinctSources: integer("distinct_sources").notNull().default(1),
  hasPrimarySource: boolean("has_primary_source").notNull().default(false),
  significance: real("significance").notNull().default(0),
  centroid: vector("centroid", { dimensions: DIM }),
}, (t) => [
  index("events_centroid_hnsw").using("hnsw", t.centroid.op("vector_cosine_ops")),
]);

export const eventEvidence = pgTable("event_evidence", {
  eventId: uuid("event_id").references(() => events.id).notNull(),
  evidenceId: uuid("evidence_id").references(() => evidenceRecords.id).notNull(),
}, (t) => [primaryKey({ columns: [t.eventId, t.evidenceId] })]);

export const briefings = pgTable("briefings", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: briefKind("kind").notNull(),
  briefDate: date("brief_date").notNull(),
  timezone: text("timezone").notNull(),
  status: briefStatus("status").notNull().default("draft"),
  executiveSummary: text("executive_summary"),
  markdown: text("markdown"),
  html: text("html"),
  coverage: jsonb("coverage").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [uniqueIndex("brief_kind_date").on(t.kind, t.briefDate)]);

export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefingId: uuid("briefing_id").references(() => briefings.id),
  eventId: uuid("event_id").references(() => events.id),
  track: text("track").notNull(),
  rank: integer("rank").notNull(),
  headline: text("headline").notNull(),
  whatHappened: text("what_happened").notNull(),
  whenWhere: text("when_where").notNull(),
  whyItMatters: text("why_it_matters").notNull(),
  whoAffected: text("who_affected").notNull(),
  implications: text("implications").notNull(),
  considerDoing: text("consider_doing"),
  watchNext: text("watch_next").notNull(),
  claimType: claimType("claim_type").notNull(),
  singleSource: boolean("single_source").notNull(),
  confidence: integer("confidence").notNull(),
  confidenceRationale: text("confidence_rationale").notNull(),
  watchlistHits: uuid("watchlist_hits").array().notNull(),
  status: findingStatus("status").notNull().default("active"),
  supersedesId: uuid("supersedes_id"),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const findingEvidence = pgTable("finding_evidence", {
  findingId: uuid("finding_id").references(() => findings.id).notNull(),
  evidenceId: uuid("evidence_id").references(() => evidenceRecords.id).notNull(),
  role: evidenceRole("role").notNull(),
}, (t) => [primaryKey({ columns: [t.findingId, t.evidenceId] })]);

export const tracks = pgTable("tracks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  priority: integer("priority").notNull(),
  maxFindings: integer("max_findings").notNull(),
  description: text("description").notNull(),
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean("enabled").notNull().default(true),
});

export const watchlistEntities = pgTable("watchlist_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull(), // own_venture | competitor | organization | topic | region
  keywords: text("keywords").array().notNull(),
  tracks: text("tracks").array().notNull(),
  notes: text("notes"),
});

// Keys: owner, schedule, ranking, budget, model_pricing (spec §3).
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const feedback = pgTable("feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: text("target_type").notNull(), // finding | briefing | evidence
  targetId: uuid("target_id").notNull(),
  rating: text("rating").notNull(), // useful | not_useful | wrong | missing_context
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose").notNull(), // classify | synthesize | edit | repair
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 5 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  runRef: text("run_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(), // system | owner | job:<name>
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
