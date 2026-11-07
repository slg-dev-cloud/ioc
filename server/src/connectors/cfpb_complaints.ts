// CFPB Consumer Complaint Database: weekly aggregates only (spec §6.2.1).
// Phase 1 never stores or surfaces individual complaint narratives.
//
// For each configured product and each completed ISO week (Mon–Sun) that ended
// at least `aggregate_lag_days` ago, emit one item with the week's count, the
// prior week's count, and the top issues. All numbers come from the API.
// Fingerprint: "<product>:<ISO week>", so a week is stored once.
import { limiterFor } from "./http.js";
import { cfg, type Connector, type RawItem } from "./types.js";

type Obj = Record<string, unknown>;
const DAY = 86_400_000;

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function isoWeekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * DAY);
}

export function isoWeekLabel(monday: Date): string {
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((isoWeekStart(thursday).getTime() - isoWeekStart(jan4).getTime()) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Completed weeks whose Sunday is at least `lagDays` before `now`, newest first. */
export function eligibleWeeks(now: Date, lagDays: number, count: number): Date[] {
  let monday = new Date(isoWeekStart(now).getTime() - 7 * DAY);
  while (monday.getTime() + 6 * DAY + lagDays * DAY > now.getTime()) monday = new Date(monday.getTime() - 7 * DAY);
  return Array.from({ length: count }, (_, i) => new Date(monday.getTime() - i * 7 * DAY));
}

export function weekQueryUrl(endpoint: string, product: string, monday: Date): string {
  const u = new URL(endpoint);
  u.searchParams.set("product", product);
  u.searchParams.set("date_received_min", ymd(monday));
  u.searchParams.set("date_received_max", ymd(new Date(monday.getTime() + 6 * DAY))); // inclusive
  u.searchParams.set("size", "0");
  return u.toString();
}

interface WeekStats { count: number; topIssues: { issue: string; count: number }[]; meta: Obj }

function parseWeek(body: Obj): WeekStats {
  const total = (body.hits as Obj | undefined)?.total as Obj | number | undefined;
  const count = typeof total === "number" ? total : Number((total as Obj | undefined)?.value);
  if (!Number.isFinite(count)) throw new Error("CFPB response has no hits.total");
  const issueAgg = (body.aggregations as Obj | undefined)?.issue as Obj | undefined;
  const buckets = ((issueAgg?.issue as Obj | undefined)?.buckets ?? issueAgg?.buckets ?? []) as Obj[];
  return {
    count,
    topIssues: buckets.slice(0, 3).map((b) => ({ issue: String(b.key), count: Number(b.doc_count) })),
    meta: (body._meta as Obj | undefined) ?? {},
  };
}

export const cfpbComplaintsConnector: Connector = {
  type: "cfpb_complaints",

  async *fetch(source, _since, ctx) {
    const endpoint = cfg<string>(source, "endpoint");
    const products = cfg<string[]>(source, "products");
    const lagDays = cfg<number>(source, "aggregate_lag_days", 7);
    const weeksBack = cfg<number>(source, "weeks_back", 2);
    const limiter = limiterFor(source.config as Obj, source.key);
    const weeks = eligibleWeeks(ctx.now, lagDays, weeksBack + 1); // +1 for the prior-week comparison

    for (const product of products) {
      const stats: WeekStats[] = [];
      for (const monday of weeks) {
        const res = await ctx.http.get(weekQueryUrl(endpoint, product, monday), { headers: { accept: "application/json" }, ...limiter });
        stats.push(parseWeek((await res.json()) as Obj));
      }
      for (let i = 0; i < weeksBack; i++) {
        yield {
          data: { product, monday: ymd(weeks[i]!), current: stats[i], prior: stats[i + 1] },
          context: { endpoint, retrievedAt: ctx.now.toISOString() },
        };
      }
    }
  },

  normalize(raw: RawItem) {
    const d = raw.data as { product: string; monday: string; current: WeekStats; prior: WeekStats };
    const monday = new Date(`${d.monday}T00:00:00Z`);
    const sunday = ymd(new Date(monday.getTime() + 6 * DAY));
    const week = isoWeekLabel(monday);
    const issues = d.current.topIssues.map((t) => `${t.issue} (${t.count})`).join("; ");
    const retrieved = String(raw.context?.retrievedAt).slice(0, 10);
    const stale = d.current.meta.is_data_stale === true ? " CFPB flags the data as stale." : "";
    return {
      title: `CFPB complaints, ${d.product}, week of ${d.monday}: ${d.current.count} received (prior week ${d.prior.count})`,
      url: weekQueryUrl(String(raw.context?.endpoint), d.product, monday),
      sourceItemId: `${d.product}:${week}`,
      excerpt:
        `Complaints received ${d.monday} to ${sunday}: ${d.current.count}. Prior week: ${d.prior.count}. ` +
        (issues ? `Top issues: ${issues}. ` : "") +
        `Retrieved ${retrieved}; CFPB publishes complaints after a delay, so counts may still rise.${stale}`,
      author: "Consumer Financial Protection Bureau",
      publishedAt: null,
      eventOccurredAt: monday,
      language: "en",
      raw: {
        aggregate: true, product: d.product, iso_week: week, week_start: d.monday, week_end: sunday,
        count: d.current.count, prior_week_count: d.prior.count, top_issues: d.current.topIssues,
        cfpb_meta: d.current.meta,
      },
    };
  },

  async healthCheck(source, http) {
    try {
      const [monday] = eligibleWeeks(new Date(), 7, 1);
      const res = await http.get(weekQueryUrl(cfg<string>(source, "endpoint"), cfg<string[]>(source, "products")[0]!, monday!), limiterFor(source.config as Obj, source.key));
      parseWeek((await res.json()) as Obj);
      return "active";
    } catch {
      return "unavailable";
    }
  },
};
