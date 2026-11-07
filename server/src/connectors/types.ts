// Connector interface: docs/PHASE1_SPEC.md §6.1.
import type { schema } from "@ioc/shared";
import type { HttpClient } from "./http.js";

export type Source = typeof schema.sources.$inferSelect;
export type ConnectorType = Source["connectorType"];
export type ConnectorStatus = Source["currentStatus"];

/** One item as the source returned it. Shape is connector-specific. */
export interface RawItem {
  data: unknown;
  /** Feed- or response-level context the item needs to normalize (e.g. RSS channel language). */
  context?: Record<string, unknown>;
}

export interface NormalizedItem {
  title: string;
  url: string;
  /** Only when many items share one URL (spec §6.2.1). */
  sourceItemId?: string;
  excerpt?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  /** "day" when the source gives only a calendar date (publishedAt is that day's midnight). */
  datePrecision?: "day";
  /** When the underlying event happened, if different from publication (e.g. a CFPB week). */
  eventOccurredAt?: Date | null;
  language?: string | null;
  /** Stored in evidence_raw. Never full article text. */
  raw: unknown;
}

export interface RunContext {
  http: HttpClient;
  now: Date;
  /** Opaque connector state from the last successful run (etag, etc.). */
  watermark: Record<string, unknown>;
  /** Merge connector state into the watermark saved after a successful run. */
  setWatermark(patch: Record<string, unknown>): void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Connector {
  type: ConnectorType;
  fetch(source: Source, since: Date, ctx: RunContext): AsyncIterable<RawItem>;
  normalize(raw: RawItem, source: Source): NormalizedItem;
  healthCheck(source: Source, http: HttpClient): Promise<ConnectorStatus>;
}

/** Read a typed value from a source's jsonb config. */
export function cfg<T>(source: Source, key: string, fallback?: T): T {
  const value = (source.config as Record<string, unknown>)[key];
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error(`source ${source.key}: config.${key} is required`);
    return fallback;
  }
  return value as T;
}
