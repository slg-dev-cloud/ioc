import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig, settingsFromProfile } from "../src/seed.js";

describe("config files", () => {
  it("config/sources.yaml and config/profile.yaml parse and cross-reference cleanly", () => {
    const cfg = loadConfig();
    expect(cfg.sourcesFile.sources.length).toBeGreaterThan(0);
    expect(cfg.profile.tracks.some((t) => t.id === "signals")).toBe(true);
  });

  it("only sources verified in Task 0 are enabled", () => {
    const { sourcesFile } = loadConfig();
    const enabled = sourcesFile.sources.filter((s) => s.enabled ?? sourcesFile.defaults.enabled);
    expect(enabled.filter((s) => !s.terms_notes).map((s) => s.key)).toEqual([]);
  });

  it("sources whose terms or access controls forbid our use stay disabled", () => {
    const { sourcesFile } = loadConfig();
    const blocked = ["dod-contracts", "war-on-the-rocks", "breaking-defense", "the-diplomat", "ars-technica"];
    const enabled = sourcesFile.sources.filter((s) => blocked.includes(s.key) && s.enabled);
    expect(enabled.map((s) => s.key)).toEqual([]);
  });

  it("rejects runtime state in source config and unknown tracks", () => {
    const cfg = loadConfig();
    const bad = structuredClone(cfg);
    bad.sourcesFile.sources[0]!.config.lastSeen = "2026-01-01";
    bad.sourcesFile.sources[0]!.tracks.push("no_such_track");
    const problems = validateConfig(bad);
    expect(problems.some((p) => p.includes("config.lastSeen"))).toBe(true);
    expect(problems.some((p) => p.includes('unknown track "no_such_track"'))).toBe(true);
  });

  it("maps owner timezone and times into the schedule setting", () => {
    const s = settingsFromProfile(loadConfig().profile) as { schedule: { timezone: string } };
    expect(s.schedule.timezone).toBe("Asia/Tokyo");
  });
});
