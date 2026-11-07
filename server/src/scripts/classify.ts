// pnpm classify [-- --max-batches N]
import { classifyPending } from "../pipeline/classify.js";
import { LlmClient } from "../llm/client.js";
import { createDb } from "../db.js";
import { requireDatabaseUrl } from "../env.js";

const argv = process.argv.slice(2);
const i = argv.indexOf("--max-batches");
const maxBatches = i >= 0 ? Number(argv[i + 1]) : undefined;
const model = process.env.MODEL_CLASSIFY;
if (!model) {
  console.error("MODEL_CLASSIFY is not set");
  process.exit(2);
}

const { db, pool } = createDb(requireDatabaseUrl());
try {
  const report = await classifyPending(db, LlmClient.fromEnv(db), {
    model, maxBatches, runRef: `classify:${new Date().toISOString()}`,
    log: (m, e) => console.error(e ? `${m} ${JSON.stringify(e)}` : m),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
