// Fresh, migrated test database. Wipes TEST_DATABASE_URL.
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "../../src/db.js";

export const testDbUrl = process.env.TEST_DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../../../shared/drizzle", import.meta.url));

export async function freshDb(): Promise<{ db: Db; end: () => Promise<void> }> {
  const conn = createDb(testDbUrl!);
  await conn.db.execute(sql`drop schema if exists public cascade`);
  await conn.db.execute(sql`drop schema if exists drizzle cascade`);
  await conn.db.execute(sql`create schema public`);
  await migrate(conn.db, { migrationsFolder });
  return { db: conn.db, end: () => conn.pool.end() };
}

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
export async function pgErrorText(p: Promise<unknown>): Promise<string | null> {
  return p.then(() => null, (e: Error & { cause?: Error }) => `${e.message}\n${e.cause?.message ?? ""}`);
}
