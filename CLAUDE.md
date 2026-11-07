# CLAUDE.md — Intelligence Operations Center (IOC)

Read `docs/PHASE1_SPEC.md` before writing code. It is the source of truth for Phase 1 scope, schema, pipeline, and milestones. `docs/MASTER_BRIEF.md` (the full vision, if present in the repo) is context only. Do not build anything from it that the Phase 1 spec marks out of scope.

## What this is
A private, single-owner intelligence system. It collects from lawful public sources, groups items into events, synthesizes findings that cite stored evidence, and delivers a daily brief at 08:00 Asia/Tokyo.

## Stack
- Node 22+, TypeScript (strict), pnpm workspaces
- `server/`: Fastify API, pg-boss workers and schedules
- `web/`: React + Vite + Tailwind
- `shared/`: Drizzle schema, zod contracts, shared types
- PostgreSQL 16 with the pgvector extension, Drizzle ORM, drizzle-kit migrations
- Anthropic SDK (`@anthropic-ai/sdk`). Model IDs come from env and are never hard-coded.

## Commands (keep these working)
- `pnpm dev`: API, workers, and web together
- `pnpm db:generate` / `pnpm db:migrate`: drizzle-kit
- `pnpm typecheck`, `pnpm test`, `pnpm lint`
- `pnpm collect -- --source <key>`: run one connector once
- `pnpm brief:dry -- --date YYYY-MM-DD`: build a brief without delivering it
- `pnpm brief:send -- --date YYYY-MM-DD`: build and deliver

## Hard rules
1. **Never fabricate.** No invented sources, URLs, quotes, numbers, customers, or events, including in fixtures presented as real. Test fixtures live in `fixtures/` and are labeled as fixtures.
2. **Evidence is append-only.** `evidence_records` rows are never updated or deleted after insert; a database trigger enforces this. Derived data (embeddings, duplicate flags) and the raw payload live in side tables keyed by `evidence_id` (spec §3). Corrections and revisions create new `findings` rows that point back via `supersedes_id`.
3. **Every finding cites evidence IDs that exist.** The citation validator (spec §7.3) is mandatory and cannot be bypassed by flags in production.
4. **Lawful collection only.**
   - Use official APIs and feeds.
   - Respect robots.txt, rate limits, and terms.
   - Never bypass logins, paywalls, CAPTCHAs, or access controls.
   - If a source can't be accessed lawfully, set its connector status to `unsupported` and move on.
5. **Never report a source as searched if it failed.** The brief's coverage section comes from `connector_runs`, not from assumptions.
6. **No empty padding.** If a track has nothing material, the brief says so in one line.
7. Secrets live only in env vars. Never log API keys or full email bodies.
8. Every LLM call goes through `server/src/llm/client.ts`, which writes a row to `llm_calls` (tokens, cost, purpose).

9. **Owner settings live in the database.** After the first seed, tracks, watchlist, ranking, budget, timezone, and schedule times are read from the DB (`tracks`, `watchlist_entities`, `settings`). Runtime code never reads `config/profile.yaml`; only `pnpm seed` does.

## Conventions
- zod schemas for every LLM input/output contract, in `shared/src/contracts/`
- Times are stored in UTC (`timestamptz`) and rendered in the owner's timezone
- Connectors implement the `Connector` interface (spec §6.1). One file per connector in `server/src/connectors/`.
- Prompts live in `server/src/prompts/*.md` with a version header. The prompt version is stored on each finding.
- Before calling a milestone done: typecheck, tests, and the milestone's acceptance check in the spec all pass.

## When unsure
- If a source endpoint or its terms differ from `config/sources.yaml`, stop and report what you found. Don't guess.
- If a schema change would alter stored evidence semantics, ask before migrating.
