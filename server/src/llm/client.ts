// The only way IOC calls a model (CLAUDE.md rule 8). Every response writes an
// llm_calls row with tokens, cost, purpose, and latency.
//
// Output is constrained with structured outputs (output_config.format) built
// from a zod schema, then validated with that schema. A response that fails
// validation gets one repair call (purpose "repair") with the error list; a
// second failure throws LlmOutputError. Forced tool_choice isn't used because
// Claude Sonnet 5.5 rejects it.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { schema } from "@ioc/shared";
import type { z } from "zod";
import type { Db } from "../db.js";
import { MissingCredentialError } from "../connectors/http.js";
import { BudgetExceededError, budgetState } from "./budget.js";
import { costUsd, priceFor, type TokenUsage } from "./pricing.js";
import { getPricing } from "./settings.js";

export type LlmPurpose = "classify" | "synthesize" | "edit" | "repair" | "embed";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The slice of the Anthropic SDK we use; tests pass a fake. */
export interface MessagesApi {
  parse(params: Anthropic.MessageCreateParamsNonStreaming & { output_config?: unknown }): Promise<{
    content: Anthropic.ContentBlock[];
    stop_reason: string | null;
    usage: Anthropic.Usage;
    parsed_output?: unknown;
  }>;
}

export class LlmOutputError extends Error {
  constructor(message: string, public issues: string[]) {
    super(message);
    this.name = "LlmOutputError";
  }
}
export class LlmStopError extends Error {
  constructor(public stopReason: string) {
    super(`model stopped with stop_reason=${stopReason}`);
    this.name = "LlmStopError";
  }
}

export interface StructuredRequest<T> {
  purpose: Exclude<LlmPurpose, "repair" | "embed">;
  model: string;
  /** Stable instructions; cached with cache_control. */
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: Effort;
  runRef?: string;
}

export interface StructuredResult<T> { data: T; usage: TokenUsage; costUsd: number; repaired: boolean }

export class LlmClient {
  constructor(private db: Db, private messages: MessagesApi, private now: () => Date = () => new Date()) {}

  static fromEnv(db: Db): LlmClient {
    if (!process.env.ANTHROPIC_API_KEY) throw new MissingCredentialError("ANTHROPIC_API_KEY");
    return new LlmClient(db, new Anthropic().messages as unknown as MessagesApi);
  }

  /** Budget checks and call logging only (e.g. embeddings); no Anthropic key needed. */
  static accountingOnly(db: Db): LlmClient {
    return new LlmClient(db, {
      parse: () => Promise.reject(new MissingCredentialError("ANTHROPIC_API_KEY")),
    });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const first = await this.call(req, req.purpose, req.user);
    const firstCheck = this.validate(req.schema, first.parsed);
    if (firstCheck.ok) return { data: firstCheck.data, usage: first.usage, costUsd: first.cost, repaired: false };

    const repairPrompt =
      `${req.user}\n\nYour previous output did not match the required schema. Problems:\n` +
      firstCheck.issues.map((i) => `- ${i}`).join("\n") +
      "\nReturn a corrected, complete output.";
    const second = await this.call(req, "repair", repairPrompt);
    const secondCheck = this.validate(req.schema, second.parsed);
    if (!secondCheck.ok) throw new LlmOutputError("output failed validation after one repair", secondCheck.issues);
    return {
      data: secondCheck.data,
      usage: sumUsage(first.usage, second.usage),
      costUsd: Math.round((first.cost + second.cost) * 1e5) / 1e5,
      repaired: true,
    };
  }

  /** For non-chat model calls (embeddings): enforce budget and log a row. */
  async recordExternalCall(args: { purpose: LlmPurpose; model: string; usage: TokenUsage; latencyMs: number; runRef?: string }) {
    const price = priceFor(await getPricing(this.db), args.model);
    const cost = costUsd(price, args.usage);
    await this.log(args.purpose, args.model, args.usage, cost, args.latencyMs, args.runRef);
    return cost;
  }

  async assertBudget(): Promise<void> {
    const state = await budgetState(this.db, this.now());
    if (state.exhausted) throw new BudgetExceededError(state);
  }

  private async call<T>(req: StructuredRequest<T>, purpose: LlmPurpose, user: string) {
    const price = priceFor(await getPricing(this.db), req.model); // refuse before spending
    await this.assertBudget();
    const started = Date.now();
    const res = await this.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens ?? 16_000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(req.schema as z.ZodType), ...(req.effort ? { effort: req.effort } : {}) },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const usage: TokenUsage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    const cost = costUsd(price, usage);
    await this.log(purpose, req.model, usage, cost, Date.now() - started, req.runRef);
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new LlmStopError(res.stop_reason);
    return { parsed: res.parsed_output ?? textJson(res.content), usage, cost };
  }

  private validate<T>(s: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; issues: string[] } {
    if (value === undefined || value === null) return { ok: false, issues: ["no JSON output was returned"] };
    const r = s.safeParse(value);
    return r.success
      ? { ok: true, data: r.data }
      : { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }

  private async log(purpose: LlmPurpose, model: string, u: TokenUsage, cost: number, latencyMs: number, runRef?: string) {
    await this.db.insert(schema.llmCalls).values({
      purpose, model,
      // Billed input includes cache reads and writes.
      inputTokens: u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      outputTokens: u.outputTokens,
      costUsd: cost.toFixed(5),
      latencyMs,
      runRef: runRef ?? null,
      createdAt: this.now(),
    });
  }
}

function textJson(content: Anthropic.ContentBlock[]): unknown {
  const text = content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}
