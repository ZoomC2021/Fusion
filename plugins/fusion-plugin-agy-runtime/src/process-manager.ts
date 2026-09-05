import { runAgyCommand } from "./cli-spawn.js";

export interface AgyModelEntry {
  id: string;
  label: string;
}

export interface AgyModelDiscoveryResult {
  models: AgyModelEntry[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
}

/*
FNXC:AgyCli 2026-09-06-00:00:
`agy models` writes a `Fetching available models...` notice to stderr, then
prints tab-separated `<id>\t<Label>` rows on stdout (no header line on stdout).
Parse stdout only: split on tab, take [0] as id and [1] as label (falling back
to the id when no tab is present), drop blank lines and the defensive fetching
notice, and dedupe by id.
*/
export function parseAgyModelLines(raw: string): AgyModelEntry[] {
  const seen = new Set<string>();
  const entries: AgyModelEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/fetching available models/i.test(trimmed)) continue;
    const tab = trimmed.indexOf("\t");
    const id = (tab === -1 ? trimmed : trimmed.slice(0, tab)).trim();
    const label = (tab === -1 ? id : trimmed.slice(tab + 1).trim()) || id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, label });
  }
  return entries;
}

export async function discoverAgyModels(binary: string, timeoutMs = 10_000): Promise<AgyModelDiscoveryResult> {
  const res = await runAgyCommand(binary, ["models"], timeoutMs);
  if (res.code !== 0) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" };
  }

  const output = (res.stdout || "").trim();
  if (!output) {
    return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no output" };
  }

  const models = parseAgyModelLines(output);
  if (models.length > 0) {
    return { models, source: "models-text", fallbackUsed: false };
  }

  return { models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no models" };
}
