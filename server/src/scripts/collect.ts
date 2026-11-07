// pnpm collect -- --source <key> [--force]
// pnpm collect -- --all            (every enabled source that has a connector)
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@ioc/shared";
import { connectors } from "../connectors/index.js";
import { HttpClient } from "../connectors/http.js";
import { runSource, SourceNotRunnableError, type RunResult } from "../connectors/runner.js";
import { createDb } from "../db.js";
import { requireDatabaseUrl } from "../env.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const sourceKey = value("--source");
if (!sourceKey && !flag("--all")) {
  console.error("Usage: pnpm collect -- --source <key> [--force]  |  pnpm collect -- --all");
  process.exit(2);
}

const { db, pool } = createDb(requireDatabaseUrl());
const http = new HttpClient(); // one client so sources sharing a limiter (GDELT) are spaced correctly
const log = (msg: string, extra?: Record<string, unknown>) =>
  console.error(extra ? `${msg} ${JSON.stringify(extra)}` : msg);

let keys: string[];
if (sourceKey) {
  keys = [sourceKey];
} else {
  const rows = await db.select({ key: schema.sources.key }).from(schema.sources).where(and(
    eq(schema.sources.enabled, true),
    inArray(schema.sources.connectorType, Object.keys(connectors) as (keyof typeof connectors)[]),
  )).orderBy(schema.sources.key);
  keys = rows.map((r) => r.key);
}

const results: RunResult[] = [];
let failed = false;
try {
  for (const key of keys) {
    try {
      results.push(await runSource(db, key, { http, force: flag("--force"), collectionMethod: "user", log }));
    } catch (err) {
      if (!(err instanceof SourceNotRunnableError)) throw err;
      console.error(err.message);
      failed = true;
    }
  }
} finally {
  await pool.end();
}

if (results.length) {
  console.table(results.map((r) => ({
    source: r.sourceKey, status: r.status, fetched: r.itemsFetched, new: r.itemsNew,
    too_old: r.itemsSkippedOld, invalid: r.itemsInvalid, error: r.error?.slice(0, 80) ?? "",
  })));
}
if (failed || results.some((r) => r.status !== "active")) process.exit(1);
