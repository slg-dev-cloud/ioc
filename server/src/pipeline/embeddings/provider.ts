// Pluggable embedding providers (spec §2: EMBEDDING_PROVIDER = voyage | openai).
// The owner chose Voyage AI. OpenAI is reserved but not built.
import { MissingCredentialError } from "../../connectors/http.js";
import { VoyageProvider } from "./voyage.js";

export interface EmbeddingResult { vectors: number[][]; totalTokens: number }

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<EmbeddingResult>;
}

export class EmbeddingDimensionError extends Error {}

export function embeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = env.EMBEDDING_PROVIDER ?? "voyage";
  const model = env.EMBEDDING_MODEL;
  const dims = Number(env.EMBEDDING_DIM ?? 1024);
  if (!model) throw new Error("EMBEDDING_MODEL is not set");
  if (!env.EMBEDDING_API_KEY) throw new MissingCredentialError("EMBEDDING_API_KEY");
  if (provider === "voyage") return new VoyageProvider(env.EMBEDDING_API_KEY, model, dims);
  throw new Error(`embedding provider "${provider}" is not built yet (only voyage)`);
}

export function checkDimensions(result: EmbeddingResult, expected: number, count: number): void {
  if (result.vectors.length !== count) throw new EmbeddingDimensionError(`expected ${count} vectors, got ${result.vectors.length}`);
  for (const v of result.vectors) {
    if (v.length !== expected) throw new EmbeddingDimensionError(`expected ${expected}-dimension vectors, got ${v.length}; EMBEDDING_DIM must match the model`);
  }
}
