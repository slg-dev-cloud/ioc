// pnpm cluster            assign new items to events and refresh significance
// pnpm cluster -- --report [N]   print the top N events with members (spot checks)
import { clusterPending, eventDigest } from "../pipeline/cluster.js";
import { createDb } from "../db.js";
import { requireDatabaseUrl } from "../env.js";

const argv = process.argv.slice(2);
const { db, pool } = createDb(requireDatabaseUrl());
try {
  if (argv.includes("--report")) {
    const n = Number(argv[argv.indexOf("--report") + 1]) || 50;
    for (const ev of await eventDigest(db, n)) {
      console.log(`\n[${ev.status}] sig=${ev.significance} sources=${ev.distinctSources}${ev.hasPrimarySource ? " primary" : ""} tracks=${ev.tracks.join(",")}`);
      console.log(`  ${ev.title}`);
      for (const m of ev.members) console.log(`    - (${m.host}) ${m.title}`);
    }
  } else {
    console.log(JSON.stringify(await clusterPending(db, { log: (m, e) => console.error(m, e ?? "") }), null, 2));
  }
} finally {
  await pool.end();
}
