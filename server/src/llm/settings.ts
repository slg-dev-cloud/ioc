// Typed access to owner settings in the DB (CLAUDE.md rule 9).
import { eq } from "drizzle-orm";
import { schema, ModelPriceSchema, RankingSchema, type ModelPrice } from "@ioc/shared";
import { z } from "zod";
import type { Db } from "../db.js";

export async function getSetting<T>(db: Db, key: string, parser: z.ZodType<T>): Promise<T> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  if (!row) throw new Error(`setting "${key}" is missing; run pnpm seed`);
  return parser.parse(row.value);
}

export const ScheduleSettingSchema = z.object({
  timezone: z.string(),
  brief_build_time: z.string(),
  brief_delivery_time: z.string(),
});
export const BudgetSettingSchema = z.object({ daily_llm_usd: z.number().positive() });
export const PricingSettingSchema = z.record(z.string(), ModelPriceSchema);

export const getPricing = (db: Db): Promise<Record<string, ModelPrice>> => getSetting(db, "model_pricing", PricingSettingSchema);
export const getBudget = (db: Db) => getSetting(db, "budget", BudgetSettingSchema);
export const getSchedule = (db: Db) => getSetting(db, "schedule", ScheduleSettingSchema);
export const getRanking = (db: Db) => getSetting(db, "ranking", RankingSchema);
