// Voyage AI embeddings. Request/response shape to be confirmed against Voyage's
// docs when the key is supplied (M3); covered by offline tests until then.
import { apiFetch, HttpError } from "../../connectors/http.js";
import type { EmbeddingProvider, EmbeddingResult } from "./provider.js";

export const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

export class VoyageProvider implements EmbeddingProvider {
  readonly name = "voyage";
  constructor(private apiKey: string, readonly model: string, readonly dimensions: number,
              private fetchImpl: (url: string, init: RequestInit) => Promise<Response> = apiFetch) {}

  async embedDocuments(texts: string[]): Promise<EmbeddingResult> {
    const res = await this.fetchImpl(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.model, input_type: "document", output_dimension: this.dimensions }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(res.status, VOYAGE_ENDPOINT);
    }
    const body = (await res.json()) as { data?: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    return { vectors: data.map((d) => d.embedding), totalTokens: Number(body.usage?.total_tokens ?? 0) };
  }
}
