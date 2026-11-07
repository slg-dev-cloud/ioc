// CPSC recalls via the SaferProducts.gov REST service. One item per recall,
// linked to its public cpsc.gov page.
import { htmlToText, makeExcerpt, zonedMidnight } from "../pipeline/normalize.js";
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;
const CPSC_TZ = "America/New_York";

const easternDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CPSC_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function buildCpscUrl(endpoint: string, since: Date): string {
  const u = new URL(endpoint);
  u.searchParams.set("format", "json");
  u.searchParams.set("RecallDateStart", easternDate(since));
  return u.toString();
}

const names = (v: unknown) =>
  Array.isArray(v) ? (v as Obj[]).map((x) => htmlToText(String(x.Name ?? ""))).filter(Boolean) : [];

export const cpscRecallsConnector: Connector = {
  type: "cpsc_recalls",

  async *fetch(source, since, ctx) {
    const url = buildCpscUrl(cfg<string>(source, "endpoint"), since);
    const res = await ctx.http.get(url, { headers: { accept: "application/json" }, ...limiterFor(source.config as Obj, source.key) });
    const recalls = (await res.json()) as Obj[];
    if (!Array.isArray(recalls)) throw new Error("CPSC response is not an array");
    for (const r of recalls) yield { data: r };
  },

  normalize(raw: RawItem) {
    const r = raw.data as Obj;
    const title = htmlToText(String(r.Title ?? ""));
    const url = String(r.URL ?? "");
    if (!title || !url) throw new Error(`recall ${String(r.RecallID)} lacks Title or URL`);
    const hazards = names(r.Hazards);
    const description = htmlToText(String(r.Description ?? ""));
    const excerpt = makeExcerpt([description, hazards.length ? `Hazard: ${hazards.join("; ")}` : ""].filter(Boolean).join(" "));
    const date = typeof r.RecallDate === "string" ? r.RecallDate.slice(0, 10) : null;
    return {
      title,
      url,
      excerpt,
      author: names(r.Manufacturers).join("; ") || null,
      publishedAt: date ? zonedMidnight(date, CPSC_TZ) : null,
      datePrecision: "day" as const,
      language: "en",
      raw: r,
    };
  },

  async healthCheck(source, http) {
    try {
      const res = await http.get(buildCpscUrl(cfg<string>(source, "endpoint"), new Date(Date.now() - 7 * 86_400_000)), limiterFor(source.config as Obj, source.key));
      return Array.isArray(await res.json()) ? "active" : "unavailable";
    } catch {
      return "unavailable";
    }
  },
};
