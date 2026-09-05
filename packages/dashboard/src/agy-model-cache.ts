/**
 * Antigravity CLI (agy) discovery → model-picker mapping, behind a short-TTL,
 * single-flight cache so `/api/models` never spawns the `agy` CLI per request.
 *
 * FNXC:AgyCli 2026-09-06-00:00:
 * Mirrors the landed Cursor pattern (FN-7696, see cursor-model-cache.ts) and
 * the Grok pattern (FN-7705, see grok-model-cache.ts). This module owns two
 * contracts:
 *   1. A deterministic discovery→model-id mapping (id = discovered id; name
 *      = label ?? id) so picker selections remain stable across requests.
 *      `agy models` yields `{ id, label }` pairs with real labels (e.g.
 *      `gemini-3.7-flash-high` → "Gemini 3.7 Flash (High)"); labels are
 *      preserved verbatim so the picker shows the human-readable name.
 *   2. A per-binaryPath TTL cache (default 60s) with single-flight
 *      de-duplication of concurrent in-flight fetches, so parallel
 *      `/api/models` requests spawn `agy` at most once per TTL window.
 * A missing/failed/unavailable `agy` binary (ENOENT, non-zero exit, timeout,
 * OS keyring/secret-service locked, no models) must degrade to an empty model
 * list — never throw — so `/api/models` always returns HTTP 200 with existing
 * rows intact. The empty result is cached briefly too, so a persistently-
 * unavailable binary does not turn into a spawn-per-request storm. agy has its
 * own settings toggle (`agyCliEnabled`); the toggle gate lives in the
 * `/api/models` merge site (register-model-routes.ts), not in this module.
 *
 * `reasoning`/`contextWindow` are not reported by `agy models` today, so they
 * default to `false`/`0` (mirroring the Grok CLI gap). This is pass-through
 * only: never fabricated, never parsed from free-text labels.
 */

import { discoverAgyCliModels } from "./runtime-provider-probes.js";

/** Stable model-picker row shape emitted for an agy-discovered model. */
export interface AgyPickerModel {
  provider: "agy-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** The picker provider id used for all agy-derived model rows. */
export const AGY_PICKER_PROVIDER_ID = "agy-cli" as const;

/** Default cache TTL for agy model discovery, in milliseconds. */
const DEFAULT_TTL_MS = 60_000;

/**
 * FNXC:AgyCli 2026-09-06-00:00:
 * A transient cold-start empty/unavailable discovery result (e.g. the `agy`
 * binary racing keychain warm-up right after the provider is toggled on) is
 * cached for this much shorter negative TTL so a first-load empty self-heals
 * quickly, while a non-empty successful discovery keeps using the normal 60s
 * TTL. Mirrors FN-7710 (Cursor). Single-flight and never-throw/never-spawn-
 * per-request guarantees are unchanged — only how long an empty result is
 * trusted.
 */
const EMPTY_RESULT_TTL_MS = 5_000;

/**
 * Map agy CLI discovery output into the stable `/api/models` row shape.
 *
 * The discovered `id` is used as the stable model id (it is the CLI's own
 * unique identifier, e.g. `"gemini-3.7-flash-high"`). `name` falls back to
 * `id` when no `label` is provided.
 *
 * `reasoning`/`contextWindow` are source-driven — when the discovery entry
 * reports them, they are carried through verbatim; otherwise they default to
 * `false`/`0`. Pass-through only: never fabricated.
 *
 * Discovered entries that map to the same id are de-duplicated, keeping the
 * first occurrence.
 */
export function agyDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string; reasoning?: boolean; contextWindow?: number }>,
): AgyPickerModel[] {
  const seen = new Set<string>();
  const result: AgyPickerModel[] = [];

  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    result.push({
      provider: AGY_PICKER_PROVIDER_ID,
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
  models: AgyPickerModel[];
  /** The TTL that applies to this specific entry (short for empty results). */
  ttlMs: number;
}

/** Per-binaryPath cache of the most recently resolved agy picker models. */
const cache = new Map<string, CacheEntry>();

/** Per-binaryPath in-flight fetch promise, for single-flight de-duplication. */
const inFlight = new Map<string, Promise<AgyPickerModel[]>>();

/**
 * Reset all cached/in-flight state. Test-only escape hatch — production code
 * should never need this since entries expire naturally via TTL.
 */
export function __resetAgyPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetAgyPickerModelsOptions {
  /** Override the agy CLI binary path. Defaults to `"agy"`. */
  binaryPath?: string;
  /** Cache TTL in milliseconds. Defaults to 60s. */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the agy CLI binary path: explicit override, then the bare `"agy"`
 * command (resolved via PATH by the CLI spawn layer). The agy plugin's own
 * probe layer has no dedicated binary-path env var convention (unlike
 * Hermes's `HERMES_BIN`), so none is consulted here.
 */
function resolveBinaryPath(explicit?: string): string {
  return explicit ?? "agy";
}

/**
 * Fetch agy CLI-discovered models for the model picker, behind a short-TTL,
 * single-flight cache keyed by binary path.
 *
 * Never throws: a `discoverAgyCliModels` failure or an unavailable-binary
 * result (empty models + `fallbackUsed: true`) resolves to `[]`, which is
 * itself cached briefly (same TTL) so a persistently-unavailable binary does
 * not spawn the CLI on every call.
 */
export async function getAgyPickerModels(
  opts?: GetAgyPickerModelsOptions,
): Promise<AgyPickerModel[]> {
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

  const fetchPromise = (async (): Promise<AgyPickerModel[]> => {
    try {
      const result = await discoverAgyCliModels({ binaryPath });
      if (!result || result.models.length === 0) {
        return [];
      }
      return agyDiscoveryToModels(result.models);
    } catch {
      // Degrade to zero agy rows on any spawn/parse failure (ENOENT,
      // non-zero exit, timeout, keyring locked) — never let an agy error
      // propagate into /api/models. See FNXC:AgyCli comment above.
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);

  try {
    const models = await fetchPromise;
    // An empty/unavailable result uses a short negative TTL so a transient
    // cold-start empty self-heals quickly instead of persisting for the full
    // 60s TTL (see FNXC:AgyCli comment above).
    const effectiveTtlMs = models.length === 0 ? EMPTY_RESULT_TTL_MS : ttlMs;
    cache.set(binaryPath, { fetchedAt: now(), models, ttlMs: effectiveTtlMs });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}
