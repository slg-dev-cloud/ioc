// Daily LLM budget guard: docs/PHASE1_SPEC.md §7.5.
// "Today" is the owner's calendar day. Embedding calls count too.
import { sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { getBudget, getSchedule } from "./settings.js";

export interface BudgetState {
  spentUsd: number;
  limitUsd: number;
  ratio: number;
  /** >= 80%: skip classification of low-priority sources. */
  lowPriorityPaused: boolean;
  /** >= 100%: stop all LLM calls. */
  exhausted: boolean;
}

export class BudgetExceededError extends Error {
  constructor(public state: BudgetState) {
    super(`daily LLM budget reached: $${state.spentUsd.toFixed(4)} of $${state.limitUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export async function budgetState(db: Db, now = new Date()): Promise<BudgetState> {
  const [{ timezone }, { daily_llm_usd }] = await Promise.all([getSchedule(db), getBudget(db)]);
  const res = await db.execute(sql`
    select coalesce(sum(cost_usd), 0)::float8 as spent
    from llm_calls
    where (created_at at time zone ${timezone})::date = (${now.toISOString()}::timestamptz at time zone ${timezone})::date`);
  const spentUsd = Number((res.rows[0] as { spent: number }).spent);
  const ratio = spentUsd / daily_llm_usd;
  return { spentUsd, limitUsd: daily_llm_usd, ratio, lowPriorityPaused: ratio >= 0.8, exhausted: ratio >= 1 };
}
