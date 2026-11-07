// CISA Known Exploited Vulnerabilities catalog. The feed is the whole catalog
// in one JSON file, so every entry shares the feed URL and is fingerprinted by
// cveID (spec §6.2.1). Only entries added since the watermark are emitted.
import { zonedMidnight } from "../pipeline/normalize.js";
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;
const CISA_TZ = "America/New_York";

const easternDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CISA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function kevExcerpt(v: Obj): string {
  const parts = [
    `Vendor/product: ${String(v.vendorProject ?? "")} ${String(v.product ?? "")}`.trim() + ".",
    String(v.shortDescription ?? "").trim(),
    v.requiredAction ? `Required action: ${String(v.requiredAction).trim()}` : "",
    v.dueDate ? `Due date: ${String(v.dueDate)}.` : "",
    v.knownRansomwareCampaignUse ? `Known ransomware campaign use: ${String(v.knownRansomwareCampaignUse)}.` : "",
  ];
  const text = parts.filter(Boolean).join(" ");
  return text.length > 1000 ? `${text.slice(0, 999).trimEnd()}…` : text;
}

export const cisaKevConnector: Connector = {
  type: "cisa_kev",

  async *fetch(source, since, ctx) {
    const url = cfg<string>(source, "url");
    const headers: Record<string, string> = { accept: "application/json" };
    if (typeof ctx.watermark.etag === "string") headers["if-none-match"] = ctx.watermark.etag;
    if (typeof ctx.watermark.lastModified === "string") headers["if-modified-since"] = ctx.watermark.lastModified;

    const res = await ctx.http.get(url, { headers, ...limiterFor(source.config as Obj, source.key) });
    if (res.status === 304) return;
    ctx.setWatermark({ etag: res.headers.get("etag") ?? undefined, lastModified: res.headers.get("last-modified") ?? undefined });

    const catalog = (await res.json()) as { catalogVersion?: string; vulnerabilities?: Obj[] };
    const floor = easternDate(since);
    for (const v of catalog.vulnerabilities ?? []) {
      if (typeof v.dateAdded === "string" && v.dateAdded >= floor) {
        yield { data: v, context: { catalogVersion: catalog.catalogVersion, url } };
      }
    }
  },

  normalize(raw: RawItem) {
    const v = raw.data as Obj;
    const cve = String(v.cveID ?? "");
    if (!/^CVE-\d{4}-\d+$/.test(cve)) throw new Error(`invalid cveID: ${cve}`);
    return {
      title: `${cve}: ${String(v.vulnerabilityName ?? "").trim()}`,
      url: String(raw.context?.url),
      sourceItemId: cve,
      excerpt: kevExcerpt(v),
      author: "CISA",
      publishedAt: typeof v.dateAdded === "string" ? zonedMidnight(v.dateAdded, CISA_TZ) : null,
      datePrecision: "day" as const,
      language: "en",
      raw: { ...v, catalogVersion: raw.context?.catalogVersion },
    };
  },

  async healthCheck(source, http) {
    try {
      const res = await http.get(cfg<string>(source, "url"), limiterFor(source.config as Obj, source.key));
      const body = (await res.json()) as { vulnerabilities?: unknown[] };
      return Array.isArray(body.vulnerabilities) ? "active" : "unavailable";
    } catch {
      return "unavailable";
    }
  },
};
