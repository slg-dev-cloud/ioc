// Normalization and fingerprinting: docs/PHASE1_SPEC.md §6.2.
import { createHash } from "node:crypto";
import { detect } from "tinyld";

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid)$/i;
export const EXCERPT_MAX = 1000;

/** Lowercase host, drop tracking params, fragment, and default port. */
export function canonicalUrl(input: string): string {
  const u = new URL(input.trim());
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** URL fingerprint, or source-scoped item fingerprint when items share a URL. */
export function fingerprint(args: { canonicalUrl: string; sourceKey: string; sourceItemId?: string }): string {
  return args.sourceItemId
    ? sha256(`item:${args.sourceKey}:${args.sourceItemId}`)
    : sha256(`url:${args.canonicalUrl}`);
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—",
  ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

/** Strip tags and scripts, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/** Feed/API summary, truncated to 1,000 chars at a word boundary. */
export function makeExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = htmlToText(text);
  if (!clean) return null;
  if (clean.length <= EXCERPT_MAX) return clean;
  const cut = clean.slice(0, EXCERPT_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > EXCERPT_MAX * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** ISO 639-1 code, or null when the text is too short to tell. */
export function detectLanguage(text: string): string | null {
  if (text.trim().length < 20) return null;
  return detect(text) || null;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Midnight of a calendar date in an IANA timezone, as a UTC instant. */
export function zonedMidnight(date: string, timeZone: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}
