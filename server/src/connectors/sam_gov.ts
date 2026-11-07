// SAM.gov Get Opportunities public API (v2).
// - The key goes in the `api_key` query parameter (per GSA docs). It comes from
//   SAM_GOV_API_KEY at run time and is never stored: evidence keeps only the
//   notice's own fields, and HTTP errors redact it.
// - The `description` field is a link that needs the key appended; we keep it
//   only as returned (no key).
// - Task 0: `uiLink` opens only for logged-in contracting roles. It is still the
//   notice's own link, used as the canonical URL until a public URL is confirmed.
import { parseDate } from "../pipeline/normalize.js";
import { limiterFor, MissingCredentialError } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;

/** MM/dd/yyyy in US Eastern, as the API requires. */
export function samDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("month")}/${g("day")}/${g("year")}`;
}

export function buildSamUrl(endpoint: string, apiKey: string, title: string, from: Date, to: Date, offset: number, limit: number): string {
  const u = new URL(endpoint);
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("postedFrom", samDate(from));
  u.searchParams.set("postedTo", samDate(to));
  u.searchParams.set("title", title);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  return u.toString();
}

function apiKey(): string {
  const key = process.env.SAM_GOV_API_KEY;
  if (!key) throw new MissingCredentialError("SAM_GOV_API_KEY");
  return key;
}

export function samExcerpt(o: Obj): string | null {
  const parts: string[] = [];
  const add = (label: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) parts.push(`${label}: ${v.trim()}.`);
  };
  add("Type", o.type);
  add("Agency", o.fullParentPathName);
  add("Solicitation number", o.solicitationNumber);
  add("NAICS", o.naicsCode);
  add("Set-aside", o.typeOfSetAsideDescription);
  add("Response deadline", o.responseDeadLine);
  return parts.length ? parts.join(" ") : null;
}

export const samGovConnector: Connector = {
  type: "sam_gov",

  async *fetch(source, since, ctx) {
    const key = apiKey();
    const endpoint = cfg<string>(source, "endpoint");
    const keywords = cfg<string[]>(source, "keywords");
    const limit = Math.min(cfg<number>(source, "limit", 1000), 1000);
    const maxPages = cfg<number>(source, "max_pages", 3);
    const limiter = limiterFor(source.config as Obj, source.key);
    // The API allows at most a 1-year posted-date range.
    const from = new Date(Math.max(since.getTime(), ctx.now.getTime() - 364 * 86_400_000));
    const seen = new Set<string>();

    for (const kw of keywords) {
      for (let page = 0; page < maxPages; page++) {
        const res = await ctx.http.get(buildSamUrl(endpoint, key, kw, from, ctx.now, page * limit, limit), { headers: { accept: "application/json" }, ...limiter });
        const body = (await res.json()) as { totalRecords?: number; opportunitiesData?: Obj[] };
        const rows = body.opportunitiesData ?? [];
        for (const o of rows) {
          const id = String(o.noticeId ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          yield { data: o, context: { keyword: kw } };
        }
        if (rows.length < limit || (page + 1) * limit >= Number(body.totalRecords ?? 0)) break;
      }
    }
  },

  normalize(raw: RawItem) {
    const o = raw.data as Obj;
    const title = String(o.title ?? "").trim();
    const url = String(o.uiLink ?? "");
    if (!title || !url) throw new Error(`notice ${String(o.noticeId)} lacks title or uiLink`);
    return {
      title,
      url,
      excerpt: samExcerpt(o),
      author: typeof o.fullParentPathName === "string" ? o.fullParentPathName : null,
      publishedAt: parseDate(o.postedDate),
      language: "en",
      raw: { ...o, matched_keyword: raw.context?.keyword },
    };
  },

  async healthCheck(source, http) {
    try {
      const now = new Date();
      await http.get(buildSamUrl(cfg<string>(source, "endpoint"), apiKey(), "software", new Date(now.getTime() - 86_400_000), now, 0, 1), limiterFor(source.config as Obj, source.key));
      return "active";
    } catch (err) {
      return err instanceof MissingCredentialError ? "auth_required" : "unavailable";
    }
  },
};
