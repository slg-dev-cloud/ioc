// Federal Register API connector (public, no key). One evidence item per document.
import { makeExcerpt, zonedMidnight } from "../pipeline/normalize.js";
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;

const FIELDS = ["title", "type", "abstract", "document_number", "html_url", "publication_date", "agencies"];
// Publication dates are US Eastern calendar dates.
const FR_TZ = "America/New_York";

export function buildFederalRegisterUrl(endpoint: string, agencies: string[], since: Date, perPage: number): string {
  const u = new URL(endpoint);
  u.searchParams.set("per_page", String(perPage));
  u.searchParams.set("order", "newest");
  for (const a of agencies) u.searchParams.append("conditions[agencies][]", a);
  u.searchParams.set("conditions[publication_date][gte]", easternDate(since));
  for (const f of FIELDS) u.searchParams.append("fields[]", f);
  return u.toString();
}

function easternDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FR_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export const federalRegisterConnector: Connector = {
  type: "federal_register",

  async *fetch(source, since, ctx) {
    const endpoint = cfg<string>(source, "endpoint");
    const agencies = cfg<string[]>(source, "agencies");
    const maxPages = cfg<number>(source, "max_pages", 5);
    let url: string | null = buildFederalRegisterUrl(endpoint, agencies, since, cfg<number>(source, "per_page", 100));
    const limiter = limiterFor(source.config as Obj, source.key);

    for (let page = 0; url && page < maxPages; page++) {
      const res = await ctx.http.get(url, { headers: { accept: "application/json" }, ...limiter });
      const body = (await res.json()) as { results?: Obj[]; next_page_url?: string | null };
      for (const doc of body.results ?? []) yield { data: doc };
      url = body.next_page_url ?? null;
      if (url && page === maxPages - 1) ctx.log("stopped at max_pages", { maxPages });
    }
  },

  normalize(raw: RawItem) {
    const doc = raw.data as Obj;
    const title = String(doc.title ?? "").trim();
    const url = String(doc.html_url ?? "");
    if (!title || !url) throw new Error(`document ${String(doc.document_number)} lacks title or html_url`);
    const agencies = Array.isArray(doc.agencies)
      ? (doc.agencies as Obj[]).map((a) => String(a.name ?? a.raw_name ?? "")).filter(Boolean)
      : [];
    const date = typeof doc.publication_date === "string" ? doc.publication_date : null;
    return {
      title,
      url,
      excerpt: makeExcerpt(typeof doc.abstract === "string" ? doc.abstract : null),
      author: agencies.join("; ") || null,
      publishedAt: date ? zonedMidnight(date, FR_TZ) : null,
      datePrecision: "day" as const,
      language: "en",
      raw: doc,
    };
  },

  async healthCheck(source, http) {
    try {
      const url = buildFederalRegisterUrl(cfg<string>(source, "endpoint"), cfg<string[]>(source, "agencies"), new Date(), 1);
      await http.get(url, limiterFor(source.config as Obj, source.key));
      return "active";
    } catch {
      return "unavailable";
    }
  },
};
