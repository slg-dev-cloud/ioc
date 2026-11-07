// GDELT DOC 2.0 API connector (ArtList mode). GDELT returns titles and links
// only, with no summary, so these items have no excerpt (Task 0 finding).
// All GDELT sources share one limiter: the API allows one request per 5 seconds.
import { detectLanguage } from "../pipeline/normalize.js";
import { HttpError, limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;

/** GDELT timestamp format: YYYYMMDDHHMMSS (UTC). */
export function gdeltTime(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function parseSeenDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : null;
}

export function buildGdeltUrl(source: { config: unknown }, since: Date, now: Date): string {
  const c = source.config as Obj;
  const u = new URL(String(c.endpoint));
  u.searchParams.set("query", String(c.query));
  u.searchParams.set("mode", String(c.mode ?? "ArtList"));
  u.searchParams.set("format", "json");
  u.searchParams.set("sort", "DateDesc");
  u.searchParams.set("maxrecords", String(Math.min(Number(c.max_records ?? 75), 250)));
  u.searchParams.set("startdatetime", gdeltTime(since));
  u.searchParams.set("enddatetime", gdeltTime(now));
  return u.toString();
}

/** GDELT sometimes answers with plain text (rate-limit notice, query errors) or an empty body. */
export function parseGdeltBody(body: string, url: string): Obj[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (/limit requests to one every/i.test(trimmed)) throw new HttpError(429, url);
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new Error(`GDELT returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
  const articles = (json as Obj).articles;
  return Array.isArray(articles) ? (articles as Obj[]) : [];
}

export const gdeltConnector: Connector = {
  type: "gdelt",

  async *fetch(source, since, ctx) {
    // The DOC API only searches recent coverage; cap the lookback.
    const maxLookbackMs = cfg<number>(source, "max_lookback_hours", 72) * 3_600_000;
    const from = new Date(Math.max(since.getTime(), ctx.now.getTime() - maxLookbackMs));
    const url = buildGdeltUrl(source, from, ctx.now);
    const res = await ctx.http.get(url, { headers: { accept: "application/json" }, ...limiterFor(source.config as Obj, source.key) });
    for (const a of parseGdeltBody(await res.text(), url)) yield { data: a };
  },

  normalize(raw: RawItem) {
    const a = raw.data as Obj;
    const title = String(a.title ?? "").trim();
    const url = String(a.url ?? "");
    if (!title || !url) throw new Error("GDELT article lacks title or url");
    return {
      title,
      url,
      excerpt: null,
      author: null,
      // seendate is when GDELT saw the article, the closest thing it gives to a publish time.
      publishedAt: parseSeenDate(a.seendate),
      language: detectLanguage(title),
      raw: a,
    };
  },

  async healthCheck(source, http) {
    try {
      const now = new Date();
      const res = await http.get(buildGdeltUrl(source, new Date(now.getTime() - 3_600_000), now), limiterFor(source.config as Obj, source.key));
      parseGdeltBody(await res.text(), "gdelt");
      return "active";
    } catch (err) {
      return err instanceof HttpError && err.status === 429 ? "rate_limited" : "unavailable";
    }
  },
};
