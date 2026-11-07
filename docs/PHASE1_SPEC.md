# IOC — Phase 1 Build Spec: The Daily Brief Spine

Owner: D'Angello (Danber Technologies / Steward Lens Group)
Builder: Claude Code
Spec version: 1.1 (2026-11-07). See §12 for changes from 1.0.

---

## 1. Goal

Deliver a trustworthy, source-linked Global Intelligence Brief every day at **08:00 Asia/Tokyo**. It must be tailored to the owner's professional and business areas and show its evidence. Everything in later phases builds on this pipeline and schema.

### In scope (Phase 1)
- A source registry and connectors for the sources in `config/sources.yaml`
- Normalization, deduplication, classification, embeddings
- Event clustering and significance ranking
- Track-level synthesis with citation validation, plus an editor pass
- Brief rendering (Markdown + HTML), email delivery, and an archive
- A minimal web UI: Today, Brief archive, Finding detail, Source health, Settings
- Feedback capture (stored only; no automated learning yet)
- LLM cost accounting and a daily budget guard

### Out of scope (later phases)
- Phase 2: full Consumer Signals brief (Brief B) and problem clustering
- Phase 3: opportunity scoring and the venture pipeline (Brief C)
- Phase 4: conversational "Ask Intelligence," real-time alerts, and multi-agent orchestration
- PDF export, mobile push, multi-user accounts

Phase 1 includes a small **Signals** section built from CFPB, CPSC, and Hacker News data. Its purpose is to exercise the consumer pipeline early.

---

## 2. Architecture

```
[schedules: pg-boss cron]
     │
     ▼
Connectors ──► normalize ──► fingerprint/dedupe ──► evidence_records (append-only)
                                                        │
                                       classify (Haiku, batched) + embed
                                                        │
                                          relevance gate (drop noise)
                                                        │
                                   event clustering (pgvector, 72h window)
                                                        │
             07:10 JST cutoff ─► rank events per track ─► synthesize findings (Sonnet)
                                                        │
                                          citation + claim validator
                                                        │
                                    editor pass (summary, actions, watch-next)
                                                        │
                                   render MD/HTML ─► store briefing ─► email 08:00 JST
```

Build and delivery times shown here are the defaults. The live values come from the `settings` table (§3, §5).

### Repo layout
```
/server/src/{connectors,pipeline,llm,prompts,jobs,api,render,delivery}
/web/src/{pages,components,lib}
/shared/src/{db/schema.ts,contracts/,types/}
/config/{sources.yaml,profile.yaml}
/fixtures/          # recorded connector responses for tests, labeled as fixtures
/docs/
```

### Environment variables
```
DATABASE_URL=
ANTHROPIC_API_KEY=
MODEL_CLASSIFY=claude-haiku-5-5         # verify current IDs in Anthropic docs
MODEL_SYNTHESIZE=claude-sonnet-5-5
EMBEDDING_PROVIDER=voyage               # pluggable: voyage | openai
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
EMBEDDING_DIM=1024                      # must match the chosen model
SAM_GOV_API_KEY=
EMAIL_PROVIDER=resend                   # resend | smtp
EMAIL_API_KEY=
BRIEF_TO=
BRIEF_FROM=
OWNER_PASSWORD_HASH=                    # argon2
SESSION_SECRET=
```

The owner timezone, schedule times, and daily LLM budget are **not** env vars. They are seeded from `config/profile.yaml` into the `settings` table and edited in the Settings page. Keeping one source of truth avoids the env and the DB disagreeing.

Hosting requirement: Postgres with **pgvector** enabled. Confirm this on the chosen host before M0.

---

## 3. Data model (Drizzle, `shared/src/db/schema.ts`)

```ts
import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb, date,
         numeric, primaryKey, index, uniqueIndex, vector, real } from "drizzle-orm/pg-core";

const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

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
  key: text("key").notNull().unique(),               // matches sources.yaml
  name: text("name").notNull(),
  connectorType: connectorType("connector_type").notNull(),
  accessMethod: accessMethod("access_method").notNull(),
  tracks: text("tracks").array().notNull(),
  isPrimary: boolean("is_primary").notNull().default(false), // official/originating source
  priority: text("priority").notNull().default("normal"), // normal | low (budget guard, §7.5)
  config: jsonb("config").notNull(),                 // from sources.yaml; owned by the seed
  cadenceMinutes: integer("cadence_minutes").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  termsNotes: text("terms_notes"),
  currentStatus: connectorStatus("current_status").notNull().default("unsupported"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Runtime collection state. Kept apart from `sources` so re-running the seed
// can never reset a watermark. The seed never writes this table.
export const sourceState = pgTable("source_state", {
  sourceId: uuid("source_id").primaryKey().references(() => sources.id),
  watermark: jsonb("watermark"),            // connector-specific, e.g. {lastSeen: "..."}
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

// Immutable after insert (enforced by trigger; see migration notes).
export const evidenceRecords = pgTable("evidence_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => sources.id).notNull(),
  sourceItemId: text("source_item_id"),     // the source's own stable id, when it has one (§6.2)
  canonicalUrl: text("canonical_url").notNull(),
  title: text("title").notNull(),
  excerpt: text("excerpt"),                 // short summary/snippet from the feed
  contentText: text("content_text"),        // only where terms permit storage
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

// Raw API/feed payload. Separate so retention (§5) can delete it without
// touching evidence_records.
export const evidenceRaw = pgTable("evidence_raw", {
  evidenceId: uuid("evidence_id").primaryKey().references(() => evidenceRecords.id),
  raw: jsonb("raw").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Derived: written by the embed job after the evidence row exists.
export const evidenceEmbeddings = pgTable("evidence_embeddings", {
  evidenceId: uuid("evidence_id").primaryKey().references(() => evidenceRecords.id),
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: DIM }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Derived: near-duplicate detection (§6.2). Rows here are excluded from clustering.
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
  entities: jsonb("entities").notNull(),     // [{name, type}]
  topics: text("topics").array().notNull(),
  relevance: integer("relevance").notNull(), // 0-100 vs owner profile
  importance: integer("importance").notNull(), // 0-100 general significance
  isNoise: boolean("is_noise").notNull(),
  watchlistHits: uuid("watchlist_hits").array().notNull(), // watchlist_entities.id
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
});

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
  coverage: jsonb("coverage").notNull(),    // per-source status for the window
  editor: jsonb("editor"),                  // editor pass output (§7.4); added in 1.1
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
  considerDoing: text("consider_doing"),     // null when nothing follows from evidence
  watchNext: text("watch_next").notNull(),
  claimType: claimType("claim_type").notNull(),
  singleSource: boolean("single_source").notNull(),
  confidence: integer("confidence").notNull(), // 0-100
  confidenceRationale: text("confidence_rationale").notNull(),
  // Derived in code at validation time: union of classifications.watchlist_hits
  // over this finding's `supports` evidence. Drives the "Your Ventures" section.
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

// Seeded from profile.yaml `tracks`; edited in Settings afterwards.
export const tracks = pgTable("tracks", {
  id: text("id").primaryKey(),             // e.g. "ai_tech"
  title: text("title").notNull(),
  priority: integer("priority").notNull(),
  maxFindings: integer("max_findings").notNull(),
  description: text("description").notNull(),
  keywords: text("keywords").array().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
});

export const watchlistEntities = pgTable("watchlist_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),   // seed matches on name
  kind: text("kind").notNull(),            // own_venture | competitor | organization | topic | region
  keywords: text("keywords").array().notNull(),
  tracks: text("tracks").array().notNull(),
  notes: text("notes"),
});

// Single-owner key/value settings, seeded from profile.yaml. Keys used in Phase 1:
//   owner         {name, organizations, context}
//   schedule      {timezone, brief_build_time, brief_delivery_time}
//   ranking       {relevance_gate, min_significance, cluster_join_cosine,
//                  cluster_strong_cosine, weights{...}}
//   budget        {daily_llm_usd}
//   model_pricing {<model id>: {input_per_mtok, output_per_mtok}}
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const feedback = pgTable("feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: text("target_type").notNull(), // finding | briefing | evidence
  targetId: uuid("target_id").notNull(),
  rating: text("rating").notNull(),          // useful | not_useful | wrong | missing_context
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose").notNull(),        // classify | synthesize | edit | repair | embed
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
  actor: text("actor").notNull(),            // system | owner | job:<name>
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Additional migration notes:
- Run `CREATE EXTENSION IF NOT EXISTS vector;` in the first migration.
- Add HNSW indexes on `evidence_embeddings.embedding` and `events.centroid` with `vector_cosine_ops`.
- **Append-only trigger:** add a `BEFORE UPDATE OR DELETE` trigger on `evidence_records` that raises an exception. No application path, migration, or job may disable it.
- Model pricing for `cost_usd` comes from the `model_pricing` setting, so it can be updated without a code change.

**Seed rules (`pnpm seed`, idempotent):**
- `sources`: upsert by `key`. YAML owns the definition fields (`name`, `connector_type`, `access_method`, `tracks`, `is_primary`, `priority`, `config`, `cadence_minutes`, `enabled`, `terms_notes`). The seed never writes `current_status` or `source_state`. Sources removed from YAML are set `enabled = false`, never deleted.
- `tracks`, `watchlist_entities`, `settings`: **insert only**. Rows that already exist are left alone, because the owner edits them in Settings. `pnpm seed -- --reset-profile` overwrites them from `profile.yaml` after a confirmation prompt, and writes an `audit_events` row.

---

## 4. Tracks

Tracks are seeded from `config/profile.yaml` into the `tracks` table. Each track has an id, a title, a priority, `max_findings`, a description used in prompts, and optional keywords. The classifier assigns 0–n tracks per item. The brief renders tracks in priority order and gives each its own section.

The one exception is the `signals` track. It has no track section. Its findings render in the compact **Signals (preview)** section (§8).

All pipeline stages (classify, rank, synthesize, render) read tracks, the watchlist, and ranking settings from the database at the start of each run, never from YAML.

---

## 5. Scheduling (pg-boss, owner TZ = Asia/Tokyo)

The timezone and the build/deliver times come from the `schedule` setting. When that setting changes, the worker re-registers the `brief:build` and `brief:deliver` schedules. The times below are the defaults.

| Job | Schedule | Notes |
|---|---|---|
| `collect:<source>` | per `cadence_minutes` | jittered ±10% |
| `classify` | every 10 min | batches of up to 25 unclassified items |
| `embed` | every 10 min | items with relevance ≥ gate |
| `cluster` | every 15 min | assigns events, updates centroids and counts |
| `brief:build` | 07:10 JST daily | window = previous build's `windowEnd` → now (default 24h) |
| `brief:deliver` | 08:00 JST daily | sends only if status = `validated` or `empty` |
| `health:check` | hourly | marks sources `unavailable` after 3 consecutive failures (`source_state.consecutive_failures`) |
| `retention` | weekly | deletes `evidence_raw` rows older than 180 days; never touches `evidence_records` |

If `brief:build` fails, `brief:deliver` sends a short failure notice with the error class and coverage. It never sends a silent skip.

---

## 6. Collection

### 6.1 Connector interface
```ts
interface Connector {
  type: ConnectorType;
  fetch(source: Source, since: Date, ctx: RunContext): AsyncIterable<RawItem>;
  normalize(raw: RawItem, source: Source): NormalizedItem; // title, url, sourceItemId?, excerpt, publishedAt, lang, raw
  healthCheck(source: Source): Promise<ConnectorStatus>;
}
```

The runner wraps every connector with the following:
- **Rate limiting:** per-source token bucket from config.
- **Retries:** exponential backoff on 429/5xx, at most 3. A 429 sets status `rate_limited`.
- **Auth failures:** 401/403 set status `auth_required` and stop.
- **Record-keeping:** a `connector_runs` row written on start and finish.
- **Watermark:** stored in `source_state.watermark`, updated only after a run finishes successfully.

### 6.2 Normalization and deduplication
- **Canonical URL:** lowercase the host; strip `utm_*`, `fbclid`, `gclid`, and fragments; resolve feed redirect wrappers where the feed provides the original link.
- **Fingerprint:**
  - If the item has its own unique URL: `sha256("url:" + canonicalUrl)`. This also dedupes the same article arriving through two sources (e.g. GDELT and an RSS feed).
  - If many items share one URL (a catalog file, an aggregate query): the connector sets `sourceItemId`, and the fingerprint is `sha256("item:" + source.key + ":" + sourceItemId)`.
- **Near-duplicates:** a secondary check runs after embedding. Cosine ≥ 0.95 with the same source host within 48h writes an `evidence_duplicates` row for the newer item. The evidence row is untouched; duplicates are excluded from clustering.
- **Excerpt:** the feed/API summary, truncated to 1,000 chars.
- **Content text:** store `content_text` only when the source's `permitted_use` allows it. Phase 1 works from titles and excerpts by default.
- **Language:** detect with a lightweight library. Non-English items are classified as-is (the model handles them); excerpts are not translated in storage.
- **Raw payload:** written to `evidence_raw` in the same transaction as the evidence row.

### 6.2.1 Connector-specific item rules

| Connector | One evidence item = | `canonicalUrl` | `sourceItemId` |
|---|---|---|---|
| `rss`, `gdelt` | one article | article link | — |
| `federal_register` | one document | the document's `html_url` from the API | — |
| `html_page` (DoD contracts) | one daily announcement page | that page's URL | — |
| `sam_gov` | one opportunity notice | the notice's `uiLink` from the API | — |
| `hn_algolia` | one story | the story URL, or `https://news.ycombinator.com/item?id=<objectID>` for text posts | — |
| `cpsc_recalls` | one recall | the recall's URL from the API | — |
| `cisa_kev` | one catalog entry (CVE) | the catalog feed URL | `cveID` |
| `cfpb_complaints` | one weekly aggregate per product | the API query URL that reproduces the count | `<product>:<ISO week>` |

Only use URLs the source itself returns. Never construct a link to a page the source didn't provide. Field names in this table (`html_url`, `uiLink`, `cveID`, `dateAdded`, and so on) are expected names; Task 0 confirms them against live responses.

**CISA KEV.** The feed is the whole catalog. Each run emits only entries whose `dateAdded` is after the watermark. Title: `<cveID>: <vulnerabilityName>`. Excerpt: vendor, product, `shortDescription`, `requiredAction`, and `dueDate`, taken verbatim from the feed.

**CFPB complaints (aggregate only).** Phase 1 never stores or surfaces individual complaint narratives.
- Once per completed ISO week, and only after `aggregate_lag_days` (default 7) have passed since the week ended, the connector emits one item per configured product.
- The title and excerpt state the week, the complaint count, the prior week's count, and the top issues with their counts. All numbers come from the API response.
- CFPB publishes complaints with a delay, so the excerpt also states the retrieval date and notes that counts may still rise.
- Later revisions of the same week are not re-emitted. The fingerprint keeps that week to one row.

**Hacker News.** `search_by_date` returns posts too new to have points, so a plain `min_points` filter drops nearly everything. Instead, each run requests stories created between the watermark and `now − min_age_hours` (default 12h), with `points >= min_points` in `numericFilters`. The watermark advances to that upper bound. Points are a snapshot at retrieval. A story that crosses the threshold after its window has passed is missed, which is acceptable in Phase 1.

### 6.3 Task 0 — Source verification (do this first)
For each entry in `config/sources.yaml`, check:
1. The endpoint responds and returns the expected format.
2. Rate limits and the current terms of use.
3. Whether storing excerpts is permitted.

Record the findings in each entry's `terms_notes` in `config/sources.yaml` (the seed copies it to `sources.terms_notes`). Set `enabled: true` only for verified sources. Report any source that differs from the config rather than adapting silently.

---

## 7. Analysis pipeline

All LLM calls use structured outputs (`output_config.format`, a JSON schema generated from the zod contract) and validate the result with that zod schema. Outputs that fail validation get one repair call (purpose `repair`) with the error list. On a second failure, the item is logged and skipped. (1.0 said "tool-use"; forced `tool_choice` is rejected by Claude Sonnet 5.5, so structured outputs replace it with the same guarantee.)

### 7.1 Classification (MODEL_CLASSIFY, batched)
**Input:** up to 25 items as `{id, title, excerpt, source_name, published_at}`, plus the track definitions (`tracks` table) and watchlist entities as `{id, name, keywords}` (`watchlist_entities` table). Both are read from the database at the start of each batch.

**Output per item:**
```ts
{ id, tracks: string[], geography: string[], entities: {name, type}[],
  topics: string[], relevance: 0-100, importance: 0-100, is_noise: boolean,
  watchlist_hits: string[] }   // watchlist entity ids from the input; unknown ids are dropped
```

**Rules:**
- `is_noise` covers ads, listicles, job posts, duplicate syndication, and items with no informational content.
- Relevance is scored against the owner profile. Importance is general significance, regardless of the owner.
- **Relevance gate:** items with `is_noise = true`, or `relevance < relevance_gate` (default 35) and no watchlist hit, are not embedded or clustered. They stay stored.

### 7.2 Event clustering (deterministic)
For each gated item, ordered by `published_at`:
1. Find candidate events with `lastSeenAt` within 72h, overlapping tracks, and cosine(centroid, item) ≥ `cluster_join_cosine` (default 0.80).
2. **Join:** if the best candidate shares at least one entity, or its cosine is ≥ `cluster_strong_cosine` (default 0.86), join it. Update the centroid (running mean), `lastSeenAt`, `distinctSources` (by source host), and `hasPrimarySource`.
3. **Create:** otherwise, create a new event titled with the item's title.
4. **Status:** an event becomes `confirmed` when `distinctSources ≥ 2` or `hasPrimarySource`. It becomes `stale` after 7 days with no new items.

Significance score (recomputed at each cluster run):
```
significance = maxImportance * 0.45 + maxRelevance * 0.35
             + min(distinctSources, 5) * 4
             + (hasPrimarySource ? 5 : 0)
             + (watchlistHit ? 10 : 0)
             - ageHours * 0.3
```

The weights live in the `ranking` setting (seeded from `profile.yaml`) and should be tuned after the first week using feedback.

Implementation notes (1.1, M4):
- **Item time** is `published_at`, or `retrieved_at` when there is none (e.g. CFPB weekly aggregates).
- **`ageHours`** is hours since the event's latest item (`last_seen_at`), so a story that keeps developing doesn't decay.
- **Shared entity** means a shared organization, person, government, or product. Locations don't count: a shared country alone would merge unrelated stories.
- **Distinct sources** count hosts with a leading `www.` removed.
- Items with no tracks never join an event (step 1 needs track overlap); each becomes its own event.
- One cluster run at a time (Postgres advisory lock).

### 7.3 Synthesis (MODEL_SYNTHESIZE, one call per track)
**Selection:**
- Events active in the brief window, ordered by significance.
- Take up to `max_findings` for the track, and only those at or above `min_significance`.
- **Zero is a valid outcome.**

**Input per event:** the event id and up to 8 evidence items, each as `{evidence_id, source_name, is_primary, host, published_at, title, excerpt, url}`.

**Output:**
```ts
{ findings: [{
    event_id, headline, what_happened, when_where, why_it_matters,
    who_affected, implications, consider_doing | null, watch_next,
    claim_type: "fact"|"allegation"|"analysis"|"forecast",
    confidence: 0-100, confidence_rationale,
    evidence: [{ evidence_id, role: "supports"|"contradicts"|"context" }]
  }],
  nothing_material: boolean }
```

**Prompt requirements** (encode these in `prompts/synthesize.md`):
- **Grounding:**
  - Use only the supplied evidence. No outside facts, figures, names, or dates.
  - If the evidence is thin, say so. Never fill gaps.
- **Separating claim types:**
  - Keep reported facts, allegations, the model's own analysis, and forecasts apart.
  - Label forecasts as such and name their uncertainty.
- **Recommendations:** `consider_doing` is null unless an action follows from the evidence and the owner context.
- **Owner context:** `why_it_matters` should connect to the owner's ventures or interests only when the connection is real. When it isn't, write about general significance.
- **Confidence:** the rationale names what drives it (source directness, corroboration, recency, conflicts).
- **Length:** each field is 1–3 sentences.
- **Numbers:** write numbers as digits, and only numbers that appear in the supplied evidence (the validator checks every field).

**Validator (code, not LLM).** A finding is rejected if any of the following holds:
1. **Unresolvable citations:** any `evidence_id` is missing from the supplied set or doesn't resolve in the database.
2. **No support:** it has zero `supports` evidence.
3. **Unsupported fact claim:** `claim_type = "fact"` without either ≥2 supporting items from distinct hosts or one `is_primary` source. In this case the validator downgrades the finding to `allegation` and sets `single_source = true` rather than rejecting it.
4. **Bad confidence fields:** confidence outside 0–100, or an empty rationale.
5. **Unsupported numbers:** any number, percentage, or currency amount in **any text field** of the finding (`headline`, `what_happened`, `when_where`, `why_it_matters`, `who_affected`, `implications`, `consider_doing`, `watch_next`, `confidence_rationale`) that doesn't appear in the allowed set. The finding gets one repair attempt; if a number still fails, the finding is dropped.

**Number check details** (deterministic code, unit-tested):
- **Allowed set:** numbers in the cited items' titles and excerpts, plus the year, month, and day of each cited item's `published_at` (in UTC and the owner timezone).
- **Normalization:** strip thousands separators (`1,200` → `1200`). Ignore surrounding `$`, `¥`, `€`, `%`, and unit words when matching. Match `5 million` and `5M` to `5000000`.
- **Ignored:** the digits in evidence or finding ids, and spelled-out numbers ("three"). The prompt tells the model to use digits.

Rejected findings are written to `audit_events` with their reasons.

### 7.4 Editor pass (MODEL_SYNTHESIZE, one call)
**Input:** the validated findings (ids, headlines, key fields) and the coverage summary.

**Output:**
```ts
{ executive_summary: string,            // 3-5 sentences, cites finding ids [F:<id>]
  most_consequential: string[],         // up to 3 finding ids
  cross_domain: [{ text, finding_ids[] }],   // only real linkages
  recommended_actions: [{ text, finding_ids[] }],
  watch_next: [{ text, finding_ids[] }] }
```

The validator checks that every referenced finding id exists in this briefing. It also runs the number check (§7.3) on each text item, using the evidence of the findings it references as the allowed set. Items that fail are dropped. If the executive summary fails, the deterministic summary below replaces it. If the editor call fails entirely, the brief still ships: it uses a deterministic summary (top 3 headlines) and a note that the editor pass failed.

### 7.5 Budget guard
Before each LLM call, check today's `llm_calls` sum (today in the owner timezone) against the `budget.daily_llm_usd` setting:
- At 80%, skip classification of items from sources with `priority = low`.
- At 100%, stop classification and build the brief from what is already classified. The coverage section notes the budget stop.

---

## 8. Brief A — Global Intelligence Brief (Phase 1 template)

Rendered Markdown → HTML (email-safe inline CSS; calm, single column, ≤ 680px).

```
# Intelligence Brief — {Weekday, D Month YYYY} (JST)
Window: {start} → {end} JST · {n} sources active · {m} limited/unavailable

## Executive Summary
{3–5 sentences}

## Most Consequential
{up to 3 findings, full card}

## {Track sections in priority order, excluding `signals`}
{finding cards, or: "No material developments in this window."}

## Your Ventures
{findings whose `watchlist_hits` include an own_venture entity, grouped by venture; one-line references}

## Signals (preview)
{findings from the `signals` track; compact list: headline · claim type · confidence · evidence refs}

## Cross-Domain Implications
## Recommended Actions
## Watch Next
## Source Coverage & Evidence
{table: source · status · items in window; failures listed explicitly}
{numbered evidence list: [E1] title — source — published — link}
```

**Finding card:**
```
### {headline}
{claim_type badge} · Confidence {n}/100{ · single source}
**What:** … **When/Where:** … **Why it matters:** … **Who's affected:** …
**Implications:** … {**Consider:** …} **Watch next:** …
Evidence: [E3] [E7] (contradicting: [E9])
Confidence basis: {rationale}
```

**Show each finding once.** A finding's full card appears once: in Most Consequential if it is selected there, otherwise in its track section. Everywhere else (its track section after Most Consequential, Your Ventures, Cross-Domain, Actions, Watch Next) it appears as a one-line reference: headline with a link to the full card.

**Signals content.** CFPB items are weekly aggregates (§6.2.1). The brief never quotes individual complaint narratives.

**Empty-day rule:** if no findings pass, the brief is status `empty`. It is still delivered, as a short note listing source coverage.

---

## 9. Web UI (Phase 1)

The tone is calm and minimal: neutral palette, one accent color, generous whitespace, light and dark modes.

| Page | Contents |
|---|---|
| **Today** | Monitoring status, last refresh time, top finding, link to today's brief, sources needing attention |
| **Briefs** | Archive by date; renders stored HTML; Markdown download |
| **Finding** | All fields, linked evidence with links out, the event timeline (all evidence in the event), superseded versions, feedback buttons |
| **Sources** | Each source's status, last run, items in 24h/7d, last error; "run now" button |
| **Settings** | Watchlist editor, track priorities and `max_findings`, ranking thresholds and weights, budget, timezone and schedule times, model pricing. Writes to `tracks`, `watchlist_entities`, and `settings`; YAML is the seed only. Each save writes an `audit_events` row. |

Auth is single-owner: password plus a session cookie (argon2 hash in env). Login attempts are rate-limited. All API routes require the session.

### API (Fastify)
```
GET  /api/status
GET  /api/briefings?from&to      GET /api/briefings/:date
GET  /api/findings/:id           GET /api/events/:id
GET  /api/sources                POST /api/sources/:key/run
POST /api/feedback
GET/PUT /api/settings
```

---

## 10. Testing and evaluation

- **Connector tests:** run against recorded responses in `/fixtures`, with no network access in CI.
- **Validator unit tests** cover each rejection rule, including number-not-in-evidence, unresolvable ids, and fact downgrade.
- **Golden set:** after the first 5 real briefs, the owner tags 30 findings as good or bad. Store these as `fixtures/golden/*.json` and add `pnpm eval`. The eval re-runs synthesis on the stored inputs and reports validator pass rate, citation correctness, and owner-tag agreement.
- **Dry run:** `pnpm brief:dry` must work against a database copy without sending email.

---

## 11. Milestones (build in order; each ends with its acceptance check)

| # | Milestone | Acceptance check |
|---|---|---|
| M0 | Scaffold workspaces, DB, migrations, seed, auth, CI scripts | `pnpm typecheck && pnpm test` pass; login works; tables and pgvector present; an UPDATE or DELETE on `evidence_records` fails; re-running `pnpm seed` leaves `source_state` and owner-edited settings unchanged |
| M1 | Task 0 source verification + connector runner + RSS, Federal Register, GDELT | Each enabled source completes a run; `connector_runs` accurate; dedupe holds on a repeated run |
| M2 | Remaining connectors (CFPB, CPSC, HN, SAM.gov, CISA KEV, html_page) | Same as M1; failing sources show the correct status |
| M3 | LLM client + cost logging + classification + embeddings + relevance gate | 200 real items classified; cost logged; manual spot check of 20 items |
| M4 | Event clustering + significance | Known multi-outlet stories collapse into one event; no cross-topic merges in a 50-event spot check |
| M5 | Synthesis + validator + editor pass | Validator tests pass; a dry-run brief has 100% resolvable citations |
| M6 | Rendering, email, schedules (07:10 build / 08:00 deliver JST), failure notice | Brief arrives at 08:00 JST ±5 min on 3 consecutive days |
| M7 | Web UI pages + feedback | All five pages work; feedback rows persist |
| M8 | Hardening: budget guard, retention, eval harness, README runbook | Budget stop simulated; `pnpm eval` runs |

**Phase 1 is done when:**
- Seven consecutive daily briefs are delivered on time.
- Zero unresolvable citations occur.
- Coverage sections match `connector_runs`.
- Average LLM cost per day stays under budget.
- The owner rates at least 60% of findings "useful."

---

## 12. Changes in 1.1

1. **Append-only evidence made consistent.** In 1.0, embeddings, duplicate flags, and retention all changed `evidence_records` after insert. They now live in `evidence_embeddings`, `evidence_duplicates`, and `evidence_raw`. A trigger blocks updates and deletes on `evidence_records`.
2. **Fingerprints for shared-URL sources.** Added `source_item_id`. CISA KEV entries and CFPB aggregates no longer collapse into one row (§6.2, §6.2.1).
3. **Hacker News collection.** Replaced the `min_points` filter on brand-new posts with an aged window (`min_age_hours`) and a server-side points filter.
4. **One source of truth for owner settings.** Added `tracks` and `settings` tables. Runtime reads tracks, the watchlist, ranking, budget, timezone, and schedule from the DB. Removed the `TZ_OWNER` and `DAILY_LLM_BUDGET_USD` env vars.
5. **Watermarks survive re-seeding.** Moved them from `sources.config` to `source_state`. Defined exactly what the seed may overwrite.
6. **Validator scope.** The number check now covers every finding text field and the editor output, with defined normalization.
7. **Brief template.** Removed the unused `fold_into`. The `signals` track renders only in Signals (preview). Each finding shows its full card once. Added `findings.watchlist_hits` to drive Your Ventures.
8. **Docs.** `MASTER_BRIEF.md` is marked optional, since it is not in the repo yet.
9. **Structured outputs (M3).** LLM calls use `output_config.format` instead of forced tool use, which Claude Sonnet 5.5 rejects. Embedding calls are logged in `llm_calls` with purpose `embed` and count toward the daily budget. A model with no price in `model_pricing` cannot be called.
10. **Clustering details (M4).** Defined item time, `ageHours`, and distinct-source hosts; locations don't count as shared entities (§7.2 implementation notes).
