# IOC — Intelligence Operations Center

Private, single-owner daily intelligence brief. Read `CLAUDE.md` and
`docs/PHASE1_SPEC.md` first.

## Local setup

Requires Node 20+, pnpm 10, and PostgreSQL 16 with the pgvector extension.

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
- Embedding provider: Voyage AI (key and model chosen in M3)
- `pnpm brief:dry` and `pnpm brief:send` are placeholders until M5 and M6.

## Collecting

```bash
pnpm collect -- --source fed-press      # one source
pnpm collect -- --all                   # every enabled source with a connector
```

Each run writes a `connector_runs` row. Sources that fail show `auth_required`,
`rate_limited`, `unsupported` (robots.txt), or `limited` → `unavailable` after
3 consecutive failures. Scheduled collection arrives with M6.
