// RSS 2.0 / RSS 1.0 / Atom connector. Stores title, link, and the feed summary
// only. Full article bodies (content:encoded, Atom <content>) are dropped,
// including from the raw payload (spec §6.2).
import { XMLParser } from "fast-xml-parser";
import { detectLanguage, htmlToText, makeExcerpt, parseDate } from "../pipeline/normalize.js";
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem, type Source } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  htmlEntities: true,
  processEntities: true,
  trimValues: true,
});

const FULL_TEXT_KEYS = ["content:encoded", "content"];

type Obj = Record<string, unknown>;
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Obj)) return String((v as Obj)["#text"]);
  return "";
}

export interface ParsedFeed { items: Obj[]; kind: "rss" | "atom" | "rdf"; language: string | null }

export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml) as Obj;
  if (doc.rss) {
    const channel = (doc.rss as Obj).channel as Obj | undefined;
    if (!channel) throw new Error("RSS document has no <channel>");
    return { kind: "rss", items: asArray(channel.item as Obj | Obj[]), language: text(channel.language) || null };
  }
  if (doc.feed) {
    const feed = doc.feed as Obj;
    return { kind: "atom", items: asArray(feed.entry as Obj | Obj[]), language: text(feed["@_xml:lang"]) || null };
  }
  if (doc["rdf:RDF"]) {
    const rdf = doc["rdf:RDF"] as Obj;
    const channel = rdf.channel as Obj | undefined;
    return { kind: "rdf", items: asArray(rdf.item as Obj | Obj[]), language: text(channel?.["dc:language"]) || null };
  }
  throw new Error("not an RSS, RDF, or Atom document");
}

function atomLink(entry: Obj): string {
  const links = asArray(entry.link as Obj | Obj[] | string);
  for (const l of links) {
    if (typeof l === "string") return l;
    const rel = text(l["@_rel"]) || "alternate";
    if (rel === "alternate" && l["@_href"]) return text(l["@_href"]);
  }
  const first = links[0];
  return typeof first === "object" && first ? text(first["@_href"]) : "";
}

export const rssConnector: Connector = {
  type: "rss",

  async *fetch(source, _since, ctx) {
    const url = cfg<string>(source, "url");
    const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" };
    // Conditional GET: be polite to publishers that support it.
    if (typeof ctx.watermark.etag === "string") headers["if-none-match"] = ctx.watermark.etag;
    if (typeof ctx.watermark.lastModified === "string") headers["if-modified-since"] = ctx.watermark.lastModified;

    const res = await ctx.http.get(url, { headers, ...limiterFor(source.config as Obj, source.key) });
    if (res.status === 304) {
      ctx.log("feed not modified");
      return;
    }
    ctx.setWatermark({
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
    });
    const feed = parseFeed(await res.text());
    for (const item of feed.items) yield { data: item, context: { kind: feed.kind, language: feed.language } };
  },

  normalize(raw: RawItem, source: Source) {
    const item = raw.data as Obj;
    const kind = raw.context?.kind as ParsedFeed["kind"];
    const title = htmlToText(text(item.title));
    const link = kind === "atom" ? atomLink(item) : text(item.link) || text(item.guid);
    if (!title) throw new Error("item has no title");
    if (!link) throw new Error(`item "${title}" has no link`);

    const summary = kind === "atom" ? text(item.summary) : text(item.description);
    const excerpt = makeExcerpt(summary);
    const published = parseDate(text(item.pubDate) || text(item["dc:date"]) || text(item.published) || text(item.updated));
    const author = htmlToText(text(item["dc:creator"]) || text((item.author as Obj | undefined)?.name) || text(item.author)) || null;
    const feedLang = typeof raw.context?.language === "string" ? raw.context.language.slice(0, 2).toLowerCase() : null;

    const rawCopy: Obj = { ...item };
    for (const k of FULL_TEXT_KEYS) delete rawCopy[k];

    return {
      title,
      url: link,
      excerpt,
      author,
      publishedAt: published,
      language: feedLang || detectLanguage(`${title} ${excerpt ?? ""}`),
      raw: { feed_kind: kind, item: rawCopy, source_key: source.key },
    };
  },

  async healthCheck(source, http) {
    try {
      const res = await http.get(cfg<string>(source, "url"), limiterFor(source.config as Obj, source.key));
      parseFeed(await res.text());
      return "active";
    } catch {
      return "unavailable";
    }
  },
};
