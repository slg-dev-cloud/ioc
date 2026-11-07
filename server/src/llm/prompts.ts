// Prompts live in server/src/prompts/*.md with a version header:
//   ---
//   version: classify-v1
//   ---
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Prompt { name: string; version: string; text: string }

export function loadPrompt(name: string): Prompt {
  const raw = readFileSync(fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const version = m ? /^version:\s*(\S+)\s*$/m.exec(m[1]!)?.[1] : undefined;
  if (!m || !version) throw new Error(`prompt ${name}.md is missing its version header`);
  return { name, version, text: m[2]!.trim() };
}
