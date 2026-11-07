// Hacker News via the Algolia search API.
// - Exact-phrase search over title and post text (plain queries match the words
//   anywhere, which returned unrelated posts in Task 0).
// - Only stories at least `min_age_hours` old, so points have accrued; the
//   points threshold is applied server-side (spec §6.2.1).
import { htmlToText, makeExcerpt, parseDate } from "../pipeline/normalize.js";
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;

export function buildHnUrl(endpoint: string, query: string, from: Date, to: Date, minPoints: number, phrase: boolean): string {
  const u = new URL(endpoint);
  u.searchParams.set("tags", "story");
  u.searchParams.set("hitsPerPage", "100");
  u.searchParams.set("numericFilters", [
    `created_at_i>${Math.floor(from.getTime() / 1000)}`,
    `created_at_i<${Math.floor(to.getTime() / 1000)}`,
    `points>=${minPoints}`,
  ].join(","));
  if (phrase) {
    u.searchParams.set("query", `"${query.replace(/"/g, "")}"`);
    u.searchParams.set("advancedSyntax", "true");
    u.searchParams.set("restrictSearchableAttributes", "title,story_text");
    u.searchParams.set("typoTolerance", "false");
  } else {
    u.searchParams.set("query", query);
  }
  return u.toString();
}

export const hnAlgoliaConnector: Connector = {
  type: "hn_algolia",

  async *fetch(source, since, ctx) {
    const endpoint = cfg<string>(source, "endpoint");
    const queries = cfg<string[]>(source, "queries");
    const minPoints = cfg<number>(source, "min_points", 20);
    const minAgeMs = cfg<number>(source, "min_age_hours", 12) * 3_600_000;
    const phrase = cfg<boolean>(source, "phrase_match", true);
    const to = new Date(ctx.now.getTime() - minAgeMs);
    if (to <= since) return; // window not open yet
    const limiter = limiterFor(source.config as Obj, source.key);
    const seen = new Set<string>();

    for (const q of queries) {
      const res = await ctx.http.get(buildHnUrl(endpoint, q, since, to, minPoints, phrase), { headers: { accept: "application/json" }, ...limiter });
      const body = (await res.json()) as { hits?: Obj[] };
      for (const hit of body.hits ?? []) {
        const id = String(hit.objectID);
        if (seen.has(id)) continue;
        seen.add(id);
        yield { data: hit, context: { query: q } };
      }
    }
  },

  normalize(raw: RawItem) {
    const h = raw.data as Obj;
    const title = htmlToText(String(h.title ?? ""));
    if (!title) throw new Error(`story ${String(h.objectID)} has no title`);
    const discussion = `https://news.ycombinator.com/item?id=${String(h.objectID)}`;
    const { _highlightResult: _h, story_text: storyText, children: _c, ...rest } = h;
    return {
      title,
      url: typeof h.url === "string" && h.url ? h.url : discussion,
      excerpt: makeExcerpt(typeof storyText === "string" ? storyText : null),
      author: typeof h.author === "string" ? h.author : null,
      publishedAt: parseDate(h.created_at),
      language: null,
      raw: { ...rest, discussion_url: discussion, matched_query: raw.context?.query },
    };
  },

  async healthCheck(source, http) {
    try {
      const now = new Date();
      await http.get(buildHnUrl(cfg<string>(source, "endpoint"), "test", new Date(now.getTime() - 86_400_000), now, 1, false), limiterFor(source.config as Obj, source.key));
      return "active";
    } catch {
      return "unavailable";
    }
  },
};
