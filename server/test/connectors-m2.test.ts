// M2 connectors against recorded and synthetic fixtures. No network.
import { afterEach, describe, expect, it } from "vitest";
import { eligibleWeeks, isoWeekLabel, isoWeekStart, weekQueryUrl } from "../src/connectors/cfpb_complaints.js";
import { extractLinks } from "../src/connectors/html_page.js";
import { MissingCredentialError } from "../src/connectors/http.js";
import { buildSamUrl, samDate } from "../src/connectors/sam_gov.js";
import { fixture } from "./helpers/fake-fetch.js";
import { fixtureSource, runFetch } from "./helpers/harness.js";

describe("cisa_kev", () => {
  const src = fixtureSource("cisa_kev", { url: "https://kev.test/feed.json" });
  const body = fixture("cisa_kev/catalog.recorded.json");

  it("emits only entries added on or after the window, keyed by CVE", async () => {
    const all = await runFetch(src, [["https://kev.test/feed.json", { body }]], { since: new Date("2000-01-01T00:00:00Z") });
    expect(all.items).toHaveLength(3);
    const newest = await runFetch(src, [["https://kev.test/feed.json", { body }]], { since: new Date("2026-11-06T12:00:00Z") });
    expect(newest.items.length).toBeLessThan(3);
    const n = all.normalize(all.items.at(-1)!);
    expect(n.sourceItemId).toMatch(/^CVE-\d{4}-\d+$/);
    expect(n.title.startsWith(`${n.sourceItemId}: `)).toBe(true);
    expect(n.url).toBe("https://kev.test/feed.json");
    expect(n.excerpt).toMatch(/Required action:/);
    expect(n.excerpt!.length).toBeLessThanOrEqual(1000);
    expect(n.datePrecision).toBe("day");
  });

  it("uses conditional GET", async () => {
    const r = await runFetch(src, [["https://kev.test/feed.json", { status: 304 }]], { watermark: { etag: '"k1"' } });
    expect(r.items).toHaveLength(0);
    expect(r.calls.find((c) => c.url === "https://kev.test/feed.json")!.headers["if-none-match"]).toBe('"k1"');
  });
});

describe("cpsc_recalls", () => {
  it("normalizes recorded recalls with public URLs and hazards", async () => {
    const src = fixtureSource("cpsc_recalls", { endpoint: "https://cpsc.test/Recall" });
    const r = await runFetch(src, [["https://cpsc.test/Recall", { body: fixture("cpsc_recalls/recalls.recorded.json") }]]);
    expect(r.items).toHaveLength(2);
    const url = new URL(r.calls.find((c) => c.url.startsWith("https://cpsc.test/Recall"))!.url);
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("RecallDateStart")).toBe("2026-11-04");
    const n = r.normalize(r.items[0]!);
    expect(n.url).toMatch(/^https:\/\/(www\.)?cpsc\.gov\/Recalls\//);
    expect(n.excerpt).toBeTruthy();
    expect(n.datePrecision).toBe("day");
  });
});

describe("cfpb_complaints (aggregates only)", () => {
  it("computes completed ISO weeks with the publication lag", () => {
    expect(isoWeekStart(new Date("2026-11-07T06:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(isoWeekLabel(new Date("2026-10-19T00:00:00Z"))).toBe("2026-W43");
    expect(isoWeekLabel(new Date("2026-12-28T00:00:00Z"))).toBe("2026-W53");
    // On Sat 2026-11-07 with a 7-day lag, the newest eligible week ended Sun 2026-10-25.
    expect(eligibleWeeks(new Date("2026-11-07T06:00:00Z"), 7, 2).map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-19", "2026-10-12"]);
    // One day later, the week ending 2026-11-01 becomes eligible.
    expect(eligibleWeeks(new Date("2026-11-08T06:00:00Z"), 7, 1)[0]!.toISOString().slice(0, 10)).toBe("2026-10-26");
  });

  it("queries Mon–Sun inclusive with size=0 (no individual complaints)", () => {
    const u = new URL(weekQueryUrl("https://cfpb.test/api/v1/", "Checking or savings account", new Date("2026-10-19T00:00:00Z")));
    expect(u.searchParams.get("date_received_min")).toBe("2026-10-19");
    expect(u.searchParams.get("date_received_max")).toBe("2026-10-25");
    expect(u.searchParams.get("size")).toBe("0");
  });

  it("emits one aggregate item per product per week, with numbers from the API", async () => {
    const src = fixtureSource("cfpb_complaints", { endpoint: "https://cfpb.test/api/v1/", products: ["Checking or savings account"], weeks_back: 2 });
    const r = await runFetch(src, [["https://cfpb.test/api/v1/", { body: fixture("cfpb_complaints/week.recorded.json") }]]);
    expect(r.items).toHaveLength(2);
    expect(r.calls.filter((c) => c.url.startsWith("https://cfpb.test/api/v1/?"))).toHaveLength(3); // 2 weeks + 1 prior
    const n = r.normalize(r.items[0]!);
    expect(n.sourceItemId).toBe("Checking or savings account:2026-W43");
    expect(n.title).toContain("1889 received");
    expect(n.excerpt).toContain("Managing an account (1103)");
    expect(n.publishedAt).toBeNull();
    expect(n.eventOccurredAt!.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(JSON.stringify(n.raw)).not.toMatch(/complaint_what_happened|complaint_id/);
  });
});

describe("hn_algolia", () => {
  const src = fixtureSource("hn_algolia", { endpoint: "https://hn.test/search_by_date", queries: ["open banking", "AI agents"], min_points: 20, min_age_hours: 12 });

  it("uses exact-phrase search, an aged window, and a server-side points filter", async () => {
    const r = await runFetch(src, [["https://hn.test/search_by_date", { body: fixture("hn_algolia/search.synthetic.json") }]]);
    const u = new URL(r.calls.find((c) => c.url.startsWith("https://hn.test/search_by_date"))!.url);
    expect(u.searchParams.get("query")).toBe('"open banking"');
    expect(u.searchParams.get("restrictSearchableAttributes")).toBe("title,story_text");
    const filters = u.searchParams.get("numericFilters")!;
    expect(filters).toContain("points>=20");
    // upper bound = now - 12h
    expect(filters).toContain(`created_at_i<${Math.floor(new Date("2026-11-06T18:00:00Z").getTime() / 1000)}`);
    // the same stories returned for both queries are yielded once
    expect(r.items).toHaveLength(2);
  });

  it("links text posts to the HN discussion and drops highlight copies", async () => {
    const r = await runFetch(src, [["https://hn.test/search_by_date", { body: fixture("hn_algolia/search.synthetic.json") }]]);
    const ask = r.normalize(r.items[0]!);
    expect(ask.url).toBe("https://news.ycombinator.com/item?id=900001");
    expect(ask.excerpt).toBe("Synthetic question text.");
    expect(JSON.stringify(ask.raw)).not.toContain("_highlightResult");
    expect(r.normalize(r.items[1]!).url).toBe("https://fixture.example.invalid/post?utm_source=hn");
  });

  it("does nothing until the aged window opens", async () => {
    const r = await runFetch(src, [], { since: new Date("2026-11-07T00:00:00Z") });
    expect(r.items).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });
});

describe("sam_gov", () => {
  const src = fixtureSource("sam_gov", { endpoint: "https://sam.test/opportunities/v2/search", keywords: ["training management"] });
  const saved = process.env.SAM_GOV_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SAM_GOV_API_KEY;
    else process.env.SAM_GOV_API_KEY = saved;
  });

  it("fails with auth_required semantics when the key is missing, before any request", async () => {
    delete process.env.SAM_GOV_API_KEY;
    await expect(runFetch(src, [])).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it("formats dates as MM/dd/yyyy and sends the key as api_key", () => {
    expect(samDate(new Date("2026-11-07T03:00:00Z"))).toBe("11/06/2026");
    const u = new URL(buildSamUrl("https://sam.test/x", "K", "range management", new Date("2026-11-01T12:00:00Z"), new Date("2026-11-07T12:00:00Z"), 0, 1000));
    expect(u.searchParams.get("api_key")).toBe("K");
    expect(u.searchParams.get("postedFrom")).toBe("11/01/2026");
    expect(u.searchParams.get("title")).toBe("range management");
  });

  it("normalizes notices without storing the key", async () => {
    process.env.SAM_GOV_API_KEY = "FIXTURE-KEY-DO-NOT-STORE";
    const r = await runFetch(src, [["https://sam.test/opportunities/v2/search", { body: fixture("sam_gov/search.synthetic.json") }]]);
    expect(r.items).toHaveLength(2);
    const n = r.normalize(r.items[0]!);
    expect(n.url).toBe("https://sam.example.invalid/opp/fixture0001/view");
    expect(n.excerpt).toContain("Type: Sources Sought.");
    expect(JSON.stringify(n)).not.toContain("FIXTURE-KEY-DO-NOT-STORE");
    expect(() => r.normalize(r.items[1]!)).toThrow(/uiLink/);
  });
});

describe("html_page", () => {
  it("extracts matching links once, resolving relative URLs", () => {
    const links = extractLinks(fixture("html_page/listing.synthetic.html"), "https://fixture.example.invalid/news/", /\/news\/contracts\//, 50);
    expect(links).toEqual([
      { href: "https://fixture.example.invalid/news/contracts/2026-11-06", text: "Contracts for Nov. 6, 2026" },
      { href: "https://fixture.example.invalid/news/contracts/2026-11-05", text: "Contracts for Nov. 5, 2026" },
    ]);
  });
});
