import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { schema } from "@ioc/shared";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}
