// HTTP layer every connector uses (spec §6.1): honest user agent, robots.txt,
// per-key rate limiting, retries with exponential backoff on 429/5xx, and
// secret redaction in errors.
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { ALLOW_ALL, parseRobots, type Robots } from "./robots.js";

export const USER_AGENT = "IOC/0.1 (+private single-owner news reader)";
export const ROBOTS_TOKEN = "IOC";

const SECRET_PARAMS = /([?&](?:api_key|apikey|key|token|access_token)=)[^&#\s]*/gi;
export function redactUrl(text: string): string {
  return text.replace(SECRET_PARAMS, "$1[redacted]");
}

export class HttpError extends Error {
  constructor(public status: number, url: string, public retryAfterMs?: number) {
    super(`HTTP ${status} from ${redactUrl(url)}`);
    this.name = "HttpError";
  }
}
export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${redactUrl(url)}`);
    this.name = "RobotsDisallowedError";
  }
}
export class NetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`network error for ${redactUrl(url)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "NetworkError";
  }
}
export class MissingCredentialError extends Error {
  constructor(envVar: string) {
    super(`${envVar} is not set`);
    this.name = "MissingCredentialError";
  }
}

export type FetchLike = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

export interface HttpClientOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  respectRobots?: boolean;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GetOptions {
  headers?: Record<string, string>;
  /** Requests sharing a key share one limiter (e.g. all GDELT sources). */
  limiterKey: string;
  /** Minimum spacing between requests for this key. */
  minIntervalMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  private opts: Required<Omit<HttpClientOptions, "fetchImpl">> & { fetchImpl: FetchLike };
  private readonly dispatcher?: Dispatcher;
  private readonly nextSlot = new Map<string, number>();
  private readonly robotsCache = new Map<string, { robots: Robots; at: number }>();

  constructor(options: HttpClientOptions = {}) {
    this.opts = {
      userAgent: options.userAgent ?? USER_AGENT,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 3,
      backoffBaseMs: options.backoffBaseMs ?? 2_000,
      respectRobots: options.respectRobots ?? true,
      fetchImpl: options.fetchImpl ?? (fetch as unknown as FetchLike),
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    };
    // Route through an HTTPS proxy when the environment defines one. Node's
    // built-in fetch rejects dispatchers from the undici package, so use
    // undici's own fetch in that case.
    if (!options.fetchImpl && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
      this.dispatcher = new EnvHttpProxyAgent();
      this.opts.fetchImpl = undiciFetch as unknown as FetchLike;
    }
  }

  /** GET with robots check, rate limit, and retries. Returns 2xx or 304 responses; throws otherwise. */
  async get(url: string, options: GetOptions): Promise<Response> {
    if (this.opts.respectRobots && !(await this.robotsAllows(url))) throw new RobotsDisallowedError(url);

    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot(options.limiterKey, options.minIntervalMs);
      let res: Response;
      try {
        res = await this.rawGet(url, options.headers);
      } catch (err) {
        if (attempt >= this.opts.maxRetries) throw new NetworkError(url, err);
        await this.opts.sleep(this.backoff(attempt));
        continue;
      }
      if (res.ok || res.status === 304) return res;

      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const retryable = res.status === 429 || res.status >= 500;
      await res.body?.cancel().catch(() => {});
      if (!retryable || attempt >= this.opts.maxRetries) throw new HttpError(res.status, url, retryAfterMs);
      await this.opts.sleep(Math.min(Math.max(retryAfterMs ?? 0, this.backoff(attempt)), 60_000));
    }
  }

  private backoff(attempt: number): number {
    return this.opts.backoffBaseMs * 2 ** attempt;
  }

  private async rawGet(url: string, headers?: Record<string, string>): Promise<Response> {
    return this.opts.fetchImpl(url, {
      headers: { "user-agent": this.opts.userAgent, ...headers },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
      redirect: "follow",
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
  }

  private async waitForSlot(key: string, minIntervalMs: number) {
    const now = this.opts.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    this.nextSlot.set(key, slot + minIntervalMs);
    if (slot > now) await this.opts.sleep(slot - now);
  }

  /**
   * RFC 9309: a 4xx robots.txt means no restrictions. A 5xx or unreachable
   * robots.txt means we may not crawl right now: that throws NetworkError (a
   * temporary failure), not a robots disallow, and is not cached.
   * Successful answers are cached per origin for 24h.
   */
  async robotsAllows(url: string): Promise<boolean> {
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return true;
    const cached = this.robotsCache.get(u.origin);
    let robots: Robots;
    if (cached && this.opts.now() - cached.at < 86_400_000) {
      robots = cached.robots;
    } else {
      robots = await this.fetchRobots(u.origin);
      this.robotsCache.set(u.origin, { robots, at: this.opts.now() });
    }
    return robots.isAllowed(u.pathname + u.search);
  }

  private async fetchRobots(origin: string): Promise<Robots> {
    const url = `${origin}/robots.txt`;
    let res: Response;
    try {
      res = await this.rawGet(url);
    } catch (err) {
      throw new NetworkError(url, err);
    }
    if (res.ok) return parseRobots(await res.text(), ROBOTS_TOKEN);
    await res.body?.cancel().catch(() => {});
    if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
    throw new NetworkError(url, new Error(`robots.txt returned HTTP ${res.status}`));
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Spacing for a source: its rate_limit_per_min, or a stricter config.min_interval_ms. */
export function limiterFor(config: Record<string, unknown>, key: string): { limiterKey: string; minIntervalMs: number } {
  const perMin = Number(config.rate_limit_per_min ?? 10);
  const fromRate = Math.ceil(60_000 / Math.max(perMin, 0.01));
  const explicit = Number(config.min_interval_ms ?? 0);
  return {
    limiterKey: String(config.rate_limit_group ?? key),
    minIntervalMs: Math.max(fromRate, explicit),
  };
}

let sharedDispatcher: Dispatcher | undefined;
/**
 * fetch for API calls that aren't collection (embeddings, email): proxy-aware,
 * no robots check. Collection must use HttpClient.
 */
export function apiFetch(url: string, init: RequestInit): Promise<Response> {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    sharedDispatcher ??= new EnvHttpProxyAgent();
    return undiciFetch(url, { ...(init as object), dispatcher: sharedDispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  }
  return fetch(url, init);
}
