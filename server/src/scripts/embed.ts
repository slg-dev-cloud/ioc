// pnpm embed [-- --max-batches N]
import { embeddingProviderFromEnv } from "../pipeline/embeddings/provider.js";
import { embedPending } from "../pipeline/embed.js";
import { LlmClient } from "../llm/client.js";
import { createDb } from "../db.js";
import { requireDatabaseUrl } from "../env.js";

const argv = process.argv.slice(2);
const i = argv.indexOf("--max-batches");
const maxBatches = i >= 0 ? Number(argv[i + 1]) : undefined;

const { db, pool } = createDb(requireDatabaseUrl());
try {
  const report = await embedPending(db, LlmClient.accountingOnly(db), embeddingProviderFromEnv(), {
    maxBatches, runRef: `embed:${new Date().toISOString()}`,
    log: (m, e) => console.error(e ? `${m} ${JSON.stringify(e)}` : m),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
