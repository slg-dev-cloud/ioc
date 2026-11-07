// pnpm seed [-- --reset-profile [--yes]]
import { createInterface } from "node:readline/promises";
import { createDb } from "../db.js";
import { requireDatabaseUrl } from "../env.js";
import { loadConfig, seed } from "../seed.js";

const args = new Set(process.argv.slice(2));
const resetProfile = args.has("--reset-profile");

if (resetProfile && !args.has("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "This overwrites tracks, watchlist entries, and settings in the DB with config/profile.yaml,\n" +
    "discarding edits made in the Settings page. Type 'reset' to continue: ");
  rl.close();
  if (answer.trim() !== "reset") {
    console.log("Aborted.");
    process.exit(1);
  }
}

const config = loadConfig();
const { db, pool } = createDb(requireDatabaseUrl());
try {
  const report = await seed(db, config, { resetProfile, actor: resetProfile ? "owner" : "system" });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
