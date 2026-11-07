// Deterministic number check (spec §7.3 rule 5). Every number, percentage, or
// currency amount a finding states must appear in its cited evidence (titles,
// excerpts) or in the cited items' publication dates.
//
// Matching is by value: "1,200" == "1200", "$5M" == "5 million" == "5,000,000".
// Currency symbols, "%", and unit words are ignored. Spelled-out numbers are
// not checked (the prompt asks for digits).

const SCALE: Record<string, number> = {
  thousand: 1e3, k: 1e3,
  million: 1e6, mn: 1e6, m: 1e6,
  billion: 1e9, bn: 1e9, b: 1e9,
  trillion: 1e12, tn: 1e12, t: 1e12,
};

// A number: digits with optional thousands separators and decimals, then an optional scale word.
const NUM_RE = /(?<![\p{L}\p{N}.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(thousand|million|billion|trillion|mn|bn|tn|[kmbt])\b)?/giu;

interface Parsed { value: number; bare: number; scaled: boolean }

function parseMatch(m: RegExpMatchArray): Parsed | null {
  const whole = m[1]!.replace(/,/g, "");
  const bare = Number(m[2] ? `${whole}.${m[2]}` : whole);
  if (!Number.isFinite(bare)) return null;
  const word = m[3]?.toLowerCase();
  if (!word) return { value: bare, bare, scaled: false };
  const numberText = m[1]! + (m[2] ? `.${m[2]}` : "");
  const suffix = m[0].slice(numberText.length);
  // Single-letter scales count only right after the digits ("5M", "$2.3B"), not "5 m".
  if (word.length === 1 && /^\s/.test(suffix)) return { value: bare, bare, scaled: false };
  return { value: bare * (SCALE[word] ?? 1), bare, scaled: true };
}

/** Values stated in text. A scaled amount ("5 million") also yields its bare number. */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const p = parseMatch(m);
    if (!p) continue;
    out.push(p.value);
    if (p.scaled) out.push(p.bare);
  }
  return out;
}

/** Year, month, and day of each date, in UTC and in the given timezone. */
export function dateNumbers(dates: (Date | null | undefined)[], timeZone: string): number[] {
  const out: number[] = [];
  for (const d of dates) {
    if (!d) continue;
    out.push(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(d);
    for (const t of ["year", "month", "day"]) {
      const v = Number(parts.find((p) => p.type === t)?.value);
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

export function buildAllowedSet(texts: (string | null | undefined)[], dates: (Date | null | undefined)[], timeZone: string): Set<number> {
  const set = new Set<number>();
  for (const t of texts) if (t) for (const n of extractNumbers(t)) set.add(roundKey(n));
  for (const n of dateNumbers(dates, timeZone)) set.add(n);
  return set;
}

const roundKey = (n: number) => Math.round(n * 1e6) / 1e6;

/** Numbers in `text` that aren't in `allowed`. A claimed "5 million" needs 5,000,000 in the evidence. */
export function unsupportedNumbers(text: string, allowed: Set<number>): number[] {
  const bad: number[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const p = parseMatch(m);
    if (p && !allowed.has(roundKey(p.value))) bad.push(p.value);
  }
  return bad;
}
