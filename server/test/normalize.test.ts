import { describe, expect, it } from "vitest";
import { canonicalUrl, decodeEntities, detectLanguage, EXCERPT_MAX, fingerprint, makeExcerpt, sha256, zonedMidnight } from "../src/pipeline/normalize.js";

describe("canonicalUrl", () => {
  it("lowercases host, strips tracking params, fragment, and default port", () => {
    expect(canonicalUrl("https://WWW.Example.COM:443/Path?utm_source=x&id=7&fbclid=y&gclid=z#frag"))
      .toBe("https://www.example.com/Path?id=7");
  });
  it("keeps meaningful query params and path case", () => {
    expect(canonicalUrl("https://example.com/A/b?page=2")).toBe("https://example.com/A/b?page=2");
  });
});

describe("fingerprint", () => {
  it("uses the URL when there is no source item id", () => {
    expect(fingerprint({ canonicalUrl: "https://a.test/x", sourceKey: "s" })).toBe(sha256("url:https://a.test/x"));
  });
  it("uses source key + item id when items share a URL", () => {
    const a = fingerprint({ canonicalUrl: "https://a.test/feed.json", sourceKey: "cisa-kev", sourceItemId: "CVE-1" });
    const b = fingerprint({ canonicalUrl: "https://a.test/feed.json", sourceKey: "cisa-kev", sourceItemId: "CVE-2" });
    expect(a).not.toBe(b);
    expect(a).toBe(sha256("item:cisa-kev:CVE-1"));
  });
});

describe("makeExcerpt", () => {
  it("strips HTML and decodes entities", () => {
    expect(makeExcerpt("<p>Fed&#8217;s <b>rate</b> &amp; plan</p>")).toBe("Fed’s rate & plan");
  });
  it("truncates to 1,000 characters at a word boundary", () => {
    const out = makeExcerpt("word ".repeat(400))!;
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns null for empty input", () => {
    expect(makeExcerpt("  <br/> ")).toBeNull();
    expect(makeExcerpt(null)).toBeNull();
  });
});

describe("helpers", () => {
  it("decodes hex, decimal, and named entities", () => {
    expect(decodeEntities("&#x2014;&#8211;&hellip;&unknown;")).toBe("—–…&unknown;");
  });
  it("converts a US Eastern calendar date to the right UTC instant (DST aware)", () => {
    expect(zonedMidnight("2026-11-06", "America/New_York").toISOString()).toBe("2026-11-06T05:00:00.000Z");
    expect(zonedMidnight("2026-07-01", "America/New_York").toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });
  it("detects language only when there is enough text", () => {
    expect(detectLanguage("short")).toBeNull();
    expect(detectLanguage("The central bank held interest rates steady this week")).toBe("en");
  });
});
