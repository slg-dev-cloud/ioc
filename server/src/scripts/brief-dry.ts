// pnpm brief:dry -- --date YYYY-MM-DD
// Builds and stores the brief for a date without delivering it. Rendering and
// email arrive in M6; this prints the findings and the citation check.
import { asc, eq } from "drizzle-orm";
import { schema } from "@ioc/shared";
import { buildBriefing, citationReport } from "../pipeline/brief.js";
import { LlmClient } from "../llm/client.js";
import { getSchedule } from "../llm/settings.js";
import { createDb } from "../db.js";
import { requireDatabaseUrl } from "../env.js";

const argv = process.argv.slice(2);
const model = process.env.MODEL_SYNTHESIZE;
if (!model) {
  console.error("MODEL_SYNTHESIZE is not set");
  process.exit(2);
}

const { db, pool } = createDb(requireDatabaseUrl());
try {
  const { timezone } = await getSchedule(db);
  const i = argv.indexOf("--date");
  const date = i >= 0 ? argv[i + 1]! : new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);

  const result = await buildBriefing(db, LlmClient.fromEnv(db), {
    date, model, actor: "owner", log: (m, e) => console.error(e ? `${m} ${JSON.stringify(e)}` : m),
  });
  const [b] = await db.select().from(schema.briefings).where(eq(schema.briefings.id, result.briefingId));
  const rows = await db.select().from(schema.findings).where(eq(schema.findings.briefingId, result.briefingId)).orderBy(asc(schema.findings.track), asc(schema.findings.rank));
  const cites = await citationReport(db, result.briefingId);

  console.log(`\nBrief ${date} (${timezone}): ${result.status}`);
  console.log(`Window: ${result.windowStart.toISOString()} -> ${result.windowEnd.toISOString()}`);
  console.log(`Findings: ${result.findings} accepted, ${result.rejected} rejected by the validator`);
  console.log(`Citations: ${cites.resolved}/${cites.cited} resolve${cites.allResolve ? " (100%)" : "  <-- NOT ALL RESOLVE"}`);
  if (b?.executiveSummary) console.log(`\nSummary: ${b.executiveSummary}`);
  for (const f of rows) console.log(`  [${f.track}] #${f.rank} ${f.headline} (${f.claimType}, ${f.confidence}/100${f.singleSource ? ", single source" : ""})`);
  if (result.status === "failed") process.exit(1);
} finally {
  await pool.end();
}
