// Cost accounting for llm_calls.cost_usd. Prices come from the model_pricing
// setting so they can change without a code change (spec §3).
import type { ModelPrice } from "@ioc/shared";

export class MissingPriceError extends Error {
  constructor(model: string) {
    super(`no price configured for model "${model}" (settings.model_pricing); refusing to call it`);
    this.name = "MissingPriceError";
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function priceFor(pricing: Record<string, ModelPrice>, model: string): ModelPrice {
  const p = pricing[model];
  if (!p) throw new MissingPriceError(model);
  return p;
}

/** USD, rounded to 5 decimals (the column's scale). */
export function costUsd(price: ModelPrice, u: TokenUsage): number {
  const read = price.cache_read_per_mtok ?? price.input_per_mtok * 0.1;
  const write = price.cache_write_per_mtok ?? price.input_per_mtok * 1.25;
  const usd =
    (u.inputTokens * price.input_per_mtok +
      u.outputTokens * price.output_per_mtok +
      (u.cacheReadTokens ?? 0) * read +
      (u.cacheWriteTokens ?? 0) * write) / 1_000_000;
  return Math.round(usd * 1e5) / 1e5;
}
