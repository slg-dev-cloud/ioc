import { buildApp } from "./app.js";
import { createDb } from "./db.js";
import { loadServerEnv } from "./env.js";

const env = loadServerEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const app = await buildApp({
  passwordHash: env.OWNER_PASSWORD_HASH,
  sessionSecret: env.SESSION_SECRET,
  secureCookie: env.NODE_ENV === "production",
  db,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
