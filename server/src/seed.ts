// Seed rules: docs/PHASE1_SPEC.md §3 ("Seed rules").
// - sources: upsert by key; YAML owns definition fields only. Never touches
//   current_status or source_state. Sources missing from YAML are disabled.
// - tracks, watchlist_entities, settings: insert only, unless resetProfile.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  schema, ProfileFileSchema, SourcesFileSchema,
  type ProfileFile, type SourcesFile,
} from "@ioc/shared";
import type { Db } from "./db.js";

const { sources, tracks, watchlistEntities, settings, auditEvents } = schema;

export const DEFAULT_CONFIG_DIR = fileURLToPath(new URL("../../config/", import.meta.url));

// Runtime state must never come from YAML (it would reset on every seed).
const FORBIDDEN_CONFIG_KEYS = ["lastSeen", "watermark", "last_seen"];

export interface LoadedConfig { sourcesFile: SourcesFile; profile: ProfileFile }

export function loadConfig(dir = DEFAULT_CONFIG_DIR): LoadedConfig {
  const sourcesFile = SourcesFileSchema.parse(parse(readFileSync(`${dir}/sources.yaml`, "utf8")));
  const profile = ProfileFileSchema.parse(parse(readFileSync(`${dir}/profile.yaml`, "utf8")));
  const problems = validateConfig({ sourcesFile, profile });
  if (problems.length) throw new Error(`Config problems:\n  ${problems.join("\n  ")}`);
  return { sourcesFile, profile };
}

/** Cross-file checks that zod can't express. Returns a list of problems. */
export function validateConfig({ sourcesFile, profile }: LoadedConfig): string[] {
  const problems: string[] = [];
  const trackIds = new Set(profile.tracks.map((t) => t.id));
  const dup = <T>(xs: T[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

  for (const k of dup(sourcesFile.sources.map((s) => s.key))) problems.push(`duplicate source key: ${k}`);
  for (const k of dup(profile.tracks.map((t) => t.id))) problems.push(`duplicate track id: ${k}`);
  for (const k of dup(profile.watchlist.map((w) => w.name))) problems.push(`duplicate watchlist name: ${k}`);

  for (const s of sourcesFile.sources) {
    for (const t of s.tracks) if (!trackIds.has(t)) problems.push(`source ${s.key}: unknown track "${t}"`);
    for (const k of FORBIDDEN_CONFIG_KEYS) {
      if (k in s.config) problems.push(`source ${s.key}: config.${k} is runtime state; it belongs in source_state`);
    }
  }
  for (const w of profile.watchlist) {
    for (const t of w.tracks) if (!trackIds.has(t)) problems.push(`watchlist ${w.name}: unknown track "${t}"`);
  }
  return problems;
}

export interface SeedOptions { resetProfile?: boolean; actor?: string }
export interface SeedReport {
  sourcesUpserted: number;
  sourcesDisabled: string[];
  tracksInserted: number;
  watchlistInserted: number;
  settingsInserted: number;
  profileReset: boolean;
}

export function settingsFromProfile(profile: ProfileFile): Record<string, unknown> {
  return {
    owner: { name: profile.owner.name, organizations: profile.owner.organizations, context: profile.owner.context },
    schedule: {
      timezone: profile.owner.timezone,
      brief_build_time: profile.owner.brief_build_time,
      brief_delivery_time: profile.owner.brief_delivery_time,
    },
    ranking: profile.ranking,
    budget: profile.budget,
    model_pricing: profile.model_pricing,
  };
}

export async function seed(db: Db, config: LoadedConfig, opts: SeedOptions = {}): Promise<SeedReport> {
  const { sourcesFile, profile } = config;
  const reset = opts.resetProfile ?? false;

  return db.transaction(async (tx) => {
    // ---- sources (YAML owns definition fields) ----
    for (const s of sourcesFile.sources) {
      const def = {
        name: s.name,
        connectorType: s.connector_type,
        accessMethod: s.access_method,
        tracks: s.tracks,
        isPrimary: s.is_primary ?? false,
        priority: s.priority ?? "normal",
        config: { rate_limit_per_min: sourcesFile.defaults.rate_limit_per_min, ...s.config },
        cadenceMinutes: s.cadence_minutes,
        enabled: s.enabled ?? sourcesFile.defaults.enabled,
        termsNotes: s.terms_notes ?? null,
      };
      await tx.insert(sources).values({ key: s.key, ...def })
        .onConflictDoUpdate({ target: sources.key, set: def });
    }
    const keys = sourcesFile.sources.map((s) => s.key);
    const disabled = await tx.update(sources).set({ enabled: false })
      .where(and(eq(sources.enabled, true), keys.length ? notInArray(sources.key, keys) : sql`true`))
      .returning({ key: sources.key });

    // ---- tracks ----
    const trackRows = profile.tracks.map((t) => ({
      id: t.id, title: t.title, priority: t.priority, maxFindings: t.max_findings,
      description: t.description, keywords: t.keywords ?? [],
    }));
    const insertedTracks = reset
      ? await tx.insert(tracks).values(trackRows).onConflictDoUpdate({
          target: tracks.id,
          set: {
            title: sql`excluded.title`, priority: sql`excluded.priority`,
            maxFindings: sql`excluded.max_findings`, description: sql`excluded.description`,
            keywords: sql`excluded.keywords`,
          },
        }).returning({ id: tracks.id })
      : await tx.insert(tracks).values(trackRows).onConflictDoNothing().returning({ id: tracks.id });

    // ---- watchlist ----
    let insertedWatch: { id: string }[] = [];
    if (profile.watchlist.length) {
      const rows = profile.watchlist.map((w) => ({
        name: w.name, kind: w.kind, keywords: w.keywords, tracks: w.tracks, notes: w.notes ?? null,
      }));
      insertedWatch = reset
        ? await tx.insert(watchlistEntities).values(rows).onConflictDoUpdate({
            target: watchlistEntities.name,
            set: {
              kind: sql`excluded.kind`, keywords: sql`excluded.keywords`,
              tracks: sql`excluded.tracks`, notes: sql`excluded.notes`,
            },
          }).returning({ id: watchlistEntities.id })
        : await tx.insert(watchlistEntities).values(rows).onConflictDoNothing()
            .returning({ id: watchlistEntities.id });
    }

    // ---- settings ----
    const settingRows = Object.entries(settingsFromProfile(profile)).map(([key, value]) => ({ key, value }));
    const insertedSettings = reset
      ? await tx.insert(settings).values(settingRows).onConflictDoUpdate({
          target: settings.key, set: { value: sql`excluded.value`, updatedAt: sql`now()` },
        }).returning({ key: settings.key })
      : await tx.insert(settings).values(settingRows).onConflictDoNothing().returning({ key: settings.key });

    const report: SeedReport = {
      sourcesUpserted: sourcesFile.sources.length,
      sourcesDisabled: disabled.map((d) => d.key),
      tracksInserted: insertedTracks.length,
      watchlistInserted: insertedWatch.length,
      settingsInserted: insertedSettings.length,
      profileReset: reset,
    };
    await tx.insert(auditEvents).values({
      actor: opts.actor ?? "system",
      action: reset ? "seed.reset_profile" : "seed",
      targetType: "config",
      detail: report,
    });
    return report;
  });
}
