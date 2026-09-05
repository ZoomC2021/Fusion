/**
 * Droid CLI discovery → model-picker mapping, behind a short-TTL,
 * single-flight cache so `/api/models` never spawns the `droid` CLI per
 * request.
 *
 * FNXC:DroidCli 2026-09-06-00:00:
 * Mirrors the landed Grok picker cache (grok-model-cache.ts, FN-7705) end to
 * end, which mirrors the Cursor picker cache (cursor-model-cache.ts, FN-7696).
 * With the Droid Runtime plugin installed and the "Factory AI — via Droid
 * CLI" provider toggle enabled (`useDroidCli === true`), this module owns two
 * contracts:
 *   1. A deterministic discovery→model-id mapping (id = discovered id; name
 *      = label ?? id) so picker selections remain stable across requests.
 *   2. A per-binaryPath TTL cache (default 60s) with single-flight
 *      de-duplication of concurrent in-flight fetches, so parallel
 *      `/api/models` requests spawn `droid` at most once per TTL window.
 * A missing/failed/unavailable `droid` binary (ENOENT, non-zero exit,
 * timeout, not authenticated) must degrade to an empty model list —
 * never throw — so `/api/models` always returns HTTP 200 with existing rows
 * intact. The empty result is cached briefly too, so a persistently-
 * unavailable binary does not turn into a spawn-per-request storm. Droid has
 * its own settings toggle (`useDroidCli`); the toggle gate lives in the
 * `/api/models` merge site (register-model-routes.ts), not in this module.
 *
 * Unlike cursor/grok (whose binary overrides live in global settings), the
 * Droid binary override lives in the droid runtime plugin's settings store
 * (`droidBinaryPath`); the merge site resolves it and threads it in here as
 * a plain binaryPath, so this module stays provider-shape-agnostic.
 */

import { discoverDroidCliModels } from "./runtime-provider-probes.js";

/** Stable model-picker row shape emitted for a Droid-discovered model. */
export interface DroidPickerModel {
  provider: "droid-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** The picker provider id used for all Droid-derived model rows. */
export const DROID_PICKER_PROVIDER_ID = "droid-cli" as const;

/** Default cache TTL for Droid model discovery, in milliseconds. */
const DEFAULT_TTL_MS = 60_000;

/**
 * FNXC:DroidCli 2026-09-06-00:00:
 * Mirrors the Cursor/Grok picker caches' negative-TTL hardening (FN-7710). A
 * transient cold-start empty/unavailable discovery result uses this much
 * shorter negative TTL so a transient cold-start empty self-heals quickly,
 * while a non-empty successful discovery keeps the normal 60s TTL.
 * Single-flight and never-throw/never-spawn-per-request guarantees are
 * unchanged — only how long an empty result is trusted.
 */
const EMPTY_RESULT_TTL_MS = 5_000;

/**
 * Map Droid CLI discovery output into the stable `/api/models` row shape.
 *
 * The discovered `id` is used as the stable model id (it is the CLI's own
 * unique identifier, e.g. `"claude-opus-5"`). `name` falls back to `id` when
 * no `label` is provided. `reasoning`/`contextWindow` default to `false`/`0`
 * — the `droid exec --help` catalog carries no such metadata today; this is
 * pass-through only, never fabricated.
 *
 * Discovered entries that map to the same id are de-duplicated, keeping the
 * first occurrence.
 */
export function droidDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string; reasoning?: boolean; contextWindow?: number }>,
): DroidPickerModel[] {
  const seen = new Set<string>();
  const result: DroidPickerModel[] = [];

  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    result.push({
      provider: DROID_PICKER_PROVIDER_ID,
      id,
      name: model.label?.trim() || id,
      reasoning: model.reasoning ?? false,
      contextWindow: model.contextWindow ?? 0,
    });
  }

  return result;
}

interface CacheEntry {
  /** Timestamp (ms) at which this entry was populated. */
  fetchedAt: number;
  /** The resolved (possibly empty, on failure/unavailability) model list. */
  models: DroidPickerModel[];
  /** The TTL that applies to this specific entry (short for empty results; see FN-7710). */
  ttlMs: number;
}

/** Per-binaryPath cache of the most recently resolved Droid picker models. */
const cache = new Map<string, CacheEntry>();

/** Per-binaryPath in-flight fetch promise, for single-flight de-duplication. */
const inFlight = new Map<string, Promise<DroidPickerModel[]>>();

/**
 * Reset all cached/in-flight state. Test-only escape hatch — production code
 * should never need this since entries expire naturally via TTL.
 */
export function __resetDroidPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetDroidPickerModelsOptions {
  /** Override the Droid CLI binary path. Defaults to `"droid"`. */
  binaryPath?: string;
  /** Cache TTL in milliseconds. Defaults to 60s. */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the Droid CLI binary path: explicit override, then the bare
 * `"droid"` command (resolved via PATH by the CLI spawn layer).
 */
function resolveBinaryPath(explicit?: string): string {
  return explicit ?? "droid";
}

/**
 * Fetch Droid CLI-discovered models for the model picker, behind a
 * short-TTL, single-flight cache keyed by binary path.
 *
 * Never throws: a `discoverDroidCliModels` failure or an unavailable-binary
 * result (empty models + `fallbackUsed: true`) resolves to `[]`, which is
 * itself cached briefly (same TTL) so a persistently-unavailable binary does
 * not spawn the CLI on every call.
 */
export async function getDroidPickerModels(
  opts?: GetDroidPickerModelsOptions,
): Promise<DroidPickerModel[]> {
  const binaryPath = resolveBinaryPath(opts?.binaryPath);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const nowMs = now();

  const cached = cache.get(binaryPath);
  if (cached && nowMs - cached.fetchedAt < cached.ttlMs) {
    return cached.models;
  }

  const existingInFlight = inFlight.get(binaryPath);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async (): Promise<DroidPickerModel[]> => {
    try {
      const result = await discoverDroidCliModels({ binaryPath });
      if (!result || result.models.length === 0) {
        return [];
      }
      return droidDiscoveryToModels(result.models);
    } catch {
      // Degrade to zero Droid rows on any spawn/parse failure (ENOENT,
      // non-zero exit, timeout, not authenticated) — never let a Droid
      // error propagate into /api/models. See FNXC:DroidCli comment above.
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);

  try {
    const models = await fetchPromise;
    // FN-7710: empty/unavailable results use a short negative TTL so a
    // transient cold-start empty self-heals quickly instead of persisting
    // for the full 60s TTL (see FNXC:DroidCli comment above).
    const effectiveTtlMs = models.length === 0 ? EMPTY_RESULT_TTL_MS : ttlMs;
    cache.set(binaryPath, { fetchedAt: now(), models, ttlMs: effectiveTtlMs });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}
