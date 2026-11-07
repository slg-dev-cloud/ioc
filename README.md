# IOC — Intelligence Operations Center

Private, single-owner daily intelligence brief. Read `CLAUDE.md` and
`docs/PHASE1_SPEC.md` first.

## Local setup

Requires Node 22+, pnpm 10, and PostgreSQL 16 with the pgvector extension.

```bash
cp .env.example .env          # fill in DATABASE_URL, SESSION_SECRET
pnpm install
pnpm --filter @ioc/server hash-password   # paste the output into OWNER_PASSWORD_HASH
pnpm db:migrate
pnpm seed
pnpm dev                      # API on :3000, web on :5173
```

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test
```

DB integration tests run when `TEST_DATABASE_URL` is set. They wipe that database.

## Status

- M0 (scaffold, schema, migrations, seed, auth, CI): done
- Task 0 (source verification): done. 16 sources enabled. See `docs/TASK0_SOURCE_VERIFICATION.md`.
- M1 (connector runner; RSS, Federal Register, GDELT connectors): done
- M2 (CISA KEV, CPSC, CFPB weekly aggregates, Hacker News, SAM.gov, html_page): done. SAM.gov stays `auth_required` until `SAM_GOV_API_KEY` is set.
- M3 (LLM client, cost logging, classification, embeddings, relevance gate): code done and tested offline; the live 200-item run waits on `ANTHROPIC_API_KEY` and the Voyage key/model
- `pnpm brief:dry` and `pnpm brief:send` are placeholders until M5 and M6.

## Analysis

```bash
pnpm classify                # classify unclassified evidence with MODEL_CLASSIFY (batches of 25)
pnpm embed                   # embed items that pass the relevance gate; marks near-duplicates
```

Every model call writes an `llm_calls` row (tokens, cost, purpose). Calls stop when
the day's spend reaches the `budget` setting; at 80%, low-priority sources are skipped.
A model with no entry in the `model_pricing` setting cannot be called.

## Collecting

```bash
pnpm collect -- --source fed-press      # one source
pnpm collect -- --all                   # every enabled source with a connector
```

Each run writes a `connector_runs` row. Sources that fail show `auth_required`,
`rate_limited`, `unsupported` (robots.txt), or `limited` → `unavailable` after
3 consecutive failures. Scheduled collection arrives with M6.
