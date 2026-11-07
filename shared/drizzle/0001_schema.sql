CREATE TYPE "public"."access_method" AS ENUM('public_api', 'public_feed', 'licensed_api', 'permitted_crawl', 'manual_import');--> statement-breakpoint
CREATE TYPE "public"."brief_kind" AS ENUM('global', 'signals');--> statement-breakpoint
CREATE TYPE "public"."brief_status" AS ENUM('draft', 'validated', 'delivered', 'failed', 'empty');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('fact', 'allegation', 'analysis', 'forecast');--> statement-breakpoint
CREATE TYPE "public"."collection_method" AS ENUM('scheduled', 'event', 'research', 'user');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('active', 'limited', 'auth_required', 'rate_limited', 'unavailable', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."connector_type" AS ENUM('rss', 'gdelt', 'federal_register', 'cfpb_complaints', 'cpsc_recalls', 'hn_algolia', 'sam_gov', 'cisa_kev', 'html_page');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('developing', 'confirmed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."evidence_role" AS ENUM('supports', 'contradicts', 'context');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('active', 'revised', 'retracted');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "brief_kind" NOT NULL,
	"brief_date" date NOT NULL,
	"timezone" text NOT NULL,
	"status" "brief_status" DEFAULT 'draft' NOT NULL,
	"executive_summary" text,
	"markdown" text,
	"html" text,
	"coverage" jsonb NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"tracks" text[] NOT NULL,
	"geography" text[] NOT NULL,
	"entities" jsonb NOT NULL,
	"topics" text[] NOT NULL,
	"relevance" integer NOT NULL,
	"importance" integer NOT NULL,
	"is_noise" boolean NOT NULL,
	"watchlist_hits" uuid[] NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "connector_status" NOT NULL,
	"items_fetched" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "event_evidence" (
	"event_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	CONSTRAINT "event_evidence_event_id_evidence_id_pk" PRIMARY KEY("event_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"tracks" text[] NOT NULL,
	"status" "event_status" DEFAULT 'developing' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"distinct_sources" integer DEFAULT 1 NOT NULL,
	"has_primary_source" boolean DEFAULT false NOT NULL,
	"significance" real DEFAULT 0 NOT NULL,
	"centroid" vector(1024)
);
--> statement-breakpoint
CREATE TABLE "evidence_duplicates" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"dup_of_id" uuid NOT NULL,
	"cosine" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_embeddings" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_raw" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_item_id" text,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"content_text" text,
	"author" text,
	"language" text,
	"published_at" timestamp with time zone,
	"event_occurred_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fingerprint" text NOT NULL,
	"collection_method" "collection_method" NOT NULL,
	"permitted_use" text
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_evidence" (
	"finding_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"role" "evidence_role" NOT NULL,
	CONSTRAINT "finding_evidence_finding_id_evidence_id_pk" PRIMARY KEY("finding_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"briefing_id" uuid,
	"event_id" uuid,
	"track" text NOT NULL,
	"rank" integer NOT NULL,
	"headline" text NOT NULL,
	"what_happened" text NOT NULL,
	"when_where" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"who_affected" text NOT NULL,
	"implications" text NOT NULL,
	"consider_doing" text,
	"watch_next" text NOT NULL,
	"claim_type" "claim_type" NOT NULL,
	"single_source" boolean NOT NULL,
	"confidence" integer NOT NULL,
	"confidence_rationale" text NOT NULL,
	"watchlist_hits" uuid[] NOT NULL,
	"status" "finding_status" DEFAULT 'active' NOT NULL,
	"supersedes_id" uuid,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(10, 5) NOT NULL,
	"latency_ms" integer NOT NULL,
	"run_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_state" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"watermark" jsonb,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"connector_type" "connector_type" NOT NULL,
	"access_method" "access_method" NOT NULL,
	"tracks" text[] NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"config" jsonb NOT NULL,
	"cadence_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"terms_notes" text,
	"current_status" "connector_status" DEFAULT 'unsupported' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"priority" integer NOT NULL,
	"max_findings" integer NOT NULL,
	"description" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"keywords" text[] NOT NULL,
	"tracks" text[] NOT NULL,
	"notes" text,
	CONSTRAINT "watchlist_entities_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_evidence" ADD CONSTRAINT "event_evidence_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_evidence" ADD CONSTRAINT "event_evidence_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_duplicates" ADD CONSTRAINT "evidence_duplicates_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_duplicates" ADD CONSTRAINT "evidence_duplicates_dup_of_id_evidence_records_id_fk" FOREIGN KEY ("dup_of_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_embeddings" ADD CONSTRAINT "evidence_embeddings_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_raw" ADD CONSTRAINT "evidence_raw_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_evidence_id_evidence_records_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_briefing_id_briefings_id_fk" FOREIGN KEY ("briefing_id") REFERENCES "public"."briefings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_state" ADD CONSTRAINT "source_state_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brief_kind_date" ON "briefings" USING btree ("kind","brief_date");--> statement-breakpoint
CREATE INDEX "runs_source_time" ON "connector_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "events_centroid_hnsw" ON "events" USING hnsw ("centroid" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "evidence_embedding_hnsw" ON "evidence_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_fingerprint" ON "evidence_records" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "evidence_published" ON "evidence_records" USING btree ("published_at");