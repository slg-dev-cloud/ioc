// Connectors against recorded and synthetic fixtures. No network.
import { describe, expect, it } from "vitest";
import { buildFederalRegisterUrl, federalRegisterConnector } from "../src/connectors/federal_register.js";
import { buildGdeltUrl, gdeltConnector, parseGdeltBody, parseSeenDate } from "../src/connectors/gdelt.js";
import { HttpClient, HttpError } from "../src/connectors/http.js";
import { rssConnector } from "../src/connectors/rss.js";
import type { RawItem, RunContext, Source } from "../src/connectors/types.js";
import { fakeFetch, fixture, noSleep, type Route } from "./helpers/fake-fetch.js";

function source(type: Source["connectorType"], config: Record<string, unknown>): Source {
  return {
    id: "00000000-0000-0000-0000-000000000000", key: `fixture-${type}`, name: "Fixture source", connectorType: type,
    accessMethod: "public_feed", tracks: ["ai_tech"], isPrimary: false, priority: "normal", config,
    cadenceMinutes: 60, enabled: true, termsNotes: null, currentStatus: "active", createdAt: new Date(),
  };
}

async function collect(src: Source, routes: Route[], watermark: Record<string, unknown> = {}) {
  const f = fakeFetch(routes);
  const patch: Record<string, unknown> = {};
  const ctx: RunContext = {
    http: new HttpClient({ fetchImpl: f, sleep: noSleep }), now: new Date("2026-11-07T06:00:00Z"),
    watermark, setWatermark: (p) => Object.assign(patch, p), log: () => {},
  };
  const items: RawItem[] = [];
  const connector = { rss: rssConnector, federal_register: federalRegisterConnector, gdelt: gdeltConnector }[src.connectorType as "rss"];
  for await (const r of connector.fetch(src, new Date("2026-11-05T00:00:00Z"), ctx)) items.push(r);
  return { items, patch, calls: f.calls, connector };
}

describe("rss connector", () => {
  it("parses the recorded Federal Reserve feed", async () => {
    const src = source("rss", { url: "https://feeds.test/fed.xml" });
    const { items, connector } = await collect(src, [["https://feeds.test/fed.xml", { body: fixture("rss/fed-press.recorded.xml") }]]);
    expect(items).toHaveLength(20);
    const all = items.map((i) => connector.normalize(i, src));
    for (const n of all) {
      expect(n.title.length).toBeGreaterThan(0);
      expect(n.url).toMatch(/^https:\/\/www\.federalreserve\.gov\//);
      expect(n.publishedAt).toBeInstanceOf(Date);
    }
  });

  it("stores the summary but never the full article body", async () => {
    const src = source("rss", { url: "https://feeds.test/s.xml" });
    const { items, connector } = await collect(src, [["https://feeds.test/s.xml", { body: fixture("rss/synthetic-fulltext.xml") }]]);
    const n = connector.normalize(items[0]!, src);
    expect(n.title).toBe("Fixture item – one");
    expect(n.excerpt).toBe("Short summary of fixture item one.");
    expect(n.author).toBe("Fixture Author");
    expect(n.language).toBe("en");
    expect(JSON.stringify(n.raw)).not.toContain("FULL ARTICLE BODY");
    expect(() => connector.normalize(items[2]!, src)).toThrow(/no title/);
  });

  it("uses the Atom alternate link and drops Atom <content>", async () => {
    const src = source("rss", { url: "https://feeds.test/a.xml" });
    const { items, connector } = await collect(src, [["https://feeds.test/a.xml", { body: fixture("rss/synthetic-atom.xml") }]]);
    const n = connector.normalize(items[0]!, src);
    expect(n.url).toBe("https://fixture.example.invalid/atom-1");
    expect(n.excerpt).toBe("Atom summary text.");
    expect(n.author).toBe("Fixture Writer");
    expect(JSON.stringify(n.raw)).not.toContain("FULL ATOM CONTENT");
  });

  it("sends conditional-GET headers and handles 304 Not Modified", async () => {
    const src = source("rss", { url: "https://feeds.test/c.xml" });
    const { items, calls } = await collect(src, [["https://feeds.test/c.xml", { status: 304 }]], { etag: '"abc"', lastModified: "Fri, 06 Nov 2026 00:00:00 GMT" });
    expect(items).toHaveLength(0);
    const req = calls.find((c) => c.url === "https://feeds.test/c.xml")!;
    expect(req.headers["if-none-match"]).toBe('"abc"');
    expect(req.headers["if-modified-since"]).toBe("Fri, 06 Nov 2026 00:00:00 GMT");
  });

  it("remembers ETag and Last-Modified for the next run", async () => {
    const src = source("rss", { url: "https://feeds.test/e.xml" });
    const { patch } = await collect(src, [["https://feeds.test/e.xml", {
      body: fixture("rss/synthetic-atom.xml"), headers: { etag: '"v2"', "last-modified": "Sat, 07 Nov 2026 00:00:00 GMT" },
    }]]);
    expect(patch).toMatchObject({ etag: '"v2"', lastModified: "Sat, 07 Nov 2026 00:00:00 GMT" });
  });
});

describe("federal register connector", () => {
  it("builds the query with agencies, date floor, and fields", () => {
    const u = new URL(buildFederalRegisterUrl("https://fr.test/api/v1/documents.json", ["a-one", "b-two"], new Date("2026-11-06T03:00:00Z"), 100));
    expect(u.searchParams.getAll("conditions[agencies][]")).toEqual(["a-one", "b-two"]);
    // 03:00 UTC on Nov 6 is still Nov 5 in US Eastern.
    expect(u.searchParams.get("conditions[publication_date][gte]")).toBe("2026-11-05");
    expect(u.searchParams.getAll("fields[]")).toContain("html_url");
  });

  it("normalizes recorded documents", async () => {
    const src = source("federal_register", { endpoint: "https://fr.test/api/v1/documents.json", agencies: ["x"] });
    const body = JSON.parse(fixture("federal_register/documents.recorded.json"));
    body.next_page_url = null;
    const { items, connector } = await collect(src, [["https://fr.test/api/v1/documents.json", { body: JSON.stringify(body) }]]);
    expect(items).toHaveLength(5);
    const n = connector.normalize(items[0]!, src);
    expect(n.url).toMatch(/^https:\/\/www\.federalregister\.gov\/documents\//);
    expect(n.author).toBeTruthy();
    expect(n.publishedAt!.toISOString()).toMatch(/T0[45]:00:00\.000Z$/);
  });

  it("follows next_page_url up to max_pages", async () => {
    const src = source("federal_register", { endpoint: "https://fr.test/api/v1/documents.json", agencies: ["x"], max_pages: 2 });
    const page = (next: string | null) => ({ body: JSON.stringify({ results: [{ title: "t", html_url: `https://fr.test/d/${next}`, publication_date: "2026-11-06" }], next_page_url: next }) });
    const { items } = await collect(src, [
      ["https://fr.test/api/v1/documents.json", page("https://fr.test/p2")],
      ["https://fr.test/p2", page("https://fr.test/p3")],
      ["https://fr.test/p3", page(null)],
    ]);
    expect(items).toHaveLength(2);
  });
});

describe("gdelt connector", () => {
  it("normalizes recorded articles with no excerpt", async () => {
    const src = source("gdelt", { endpoint: "https://gdelt.test/doc", query: "q" });
    const { items, connector } = await collect(src, [["https://gdelt.test/doc", { body: fixture("gdelt/artlist.recorded.json") }]]);
    expect(items).toHaveLength(3);
    const n = connector.normalize(items[0]!, src);
    expect(n.excerpt).toBeNull();
    expect(n.publishedAt).toBeInstanceOf(Date);
  });

  it("treats GDELT's plain-text rate-limit notice as a 429", () => {
    expect(() => parseGdeltBody(fixture("gdelt/rate-limit-notice.recorded.txt"), "u")).toThrow(HttpError);
  });

  it("handles empty bodies and caps maxrecords at 250", () => {
    expect(parseGdeltBody("  ", "u")).toEqual([]);
    const u = new URL(buildGdeltUrl({ config: { endpoint: "https://g.test/doc", query: "q", max_records: 999 } }, new Date("2026-11-06T00:00:00Z"), new Date("2026-11-07T00:00:00Z")));
    expect(u.searchParams.get("maxrecords")).toBe("250");
    expect(u.searchParams.get("startdatetime")).toBe("20261106000000");
  });

  it("parses seendate", () => {
    expect(parseSeenDate("20261107T013000Z")!.toISOString()).toBe("2026-11-07T01:30:00.000Z");
    expect(parseSeenDate("bad")).toBeNull();
  });
});
