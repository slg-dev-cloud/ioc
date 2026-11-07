// Generic link-list page connector, for official pages that publish no feed and
// whose terms and robots.txt permit automated reading. It collects links whose
// href matches `link_pattern`, using the link text as the title. It never
// fetches the linked pages. robots.txt is enforced by the HTTP client.
import { htmlToText } from "../pipeline/normalize.js";
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;

export function extractLinks(html: string, baseUrl: string, pattern: RegExp, max: number): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m; (m = re.exec(html)) && out.length < max;) {
    let href: string;
    try {
      href = new URL(htmlToText(m[2]!), baseUrl).toString();
    } catch {
      continue;
    }
    const text = htmlToText(m[3]!);
    if (!text || !pattern.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text });
  }
  return out;
}

export const htmlPageConnector: Connector = {
  type: "html_page",

  async *fetch(source, _since, ctx) {
    const url = cfg<string>(source, "url");
    const pattern = new RegExp(cfg<string>(source, "link_pattern"));
    const res = await ctx.http.get(url, { headers: { accept: "text/html" }, ...limiterFor(source.config as Obj, source.key) });
    for (const link of extractLinks(await res.text(), res.url || url, pattern, cfg<number>(source, "max_items", 50))) {
      yield { data: link, context: { page: url } };
    }
  },

  normalize(raw: RawItem) {
    const { href, text } = raw.data as { href: string; text: string };
    return { title: text, url: href, excerpt: null, publishedAt: null, language: null, raw: { href, text, page: raw.context?.page } };
  },

  async healthCheck(source, http) {
    try {
      await http.get(cfg<string>(source, "url"), limiterFor(source.config as Obj, source.key));
      return "active";
    } catch {
      return "unavailable";
    }
  },
};
