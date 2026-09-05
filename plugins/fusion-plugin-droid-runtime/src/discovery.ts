/**
 * Model-discovery contribution for the Droid CLI.
 *
 * Mirrors the Grok plugin's `discoverGrokProviderModels` shape exactly: probe
 * the binary first, then parse the `droid exec --help` catalog into the
 * `CliProviderModelDiscoveryResult` contract
 * (`{ models: [{ id, label }], source, fallbackUsed, reason? }`).
 *
 * Never throws: an unavailable binary resolves to
 * `{ models: [], source: "probe", fallbackUsed: true, reason }`, and a failed
 * catalog spawn degrades to an empty model list. The dashboard's model-picker
 * cache (packages/dashboard/src/droid-model-cache.ts) is the stable mock/spy
 * boundary above this module.
 */

import { probeDroidBinary } from "./probe.js";
import { discoverDroidModelEntries } from "./process-manager.js";

function normalizeDiscoveryOptions(options?: unknown): { binaryPath?: string; timeoutMs?: number } {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return {
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : undefined,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

export async function discoverDroidProviderModels(options?: unknown) {
  const { binaryPath, timeoutMs } = normalizeDiscoveryOptions(options);
  const probe = await probeDroidBinary({ binaryPath, timeoutMs });
  if (!probe.available || !probe.binaryPath) {
    return {
      models: [] as Array<{ id: string; label?: string }>,
      source: "probe",
      fallbackUsed: true,
      reason: probe.reason ?? "binary unavailable",
    };
  }
  const entries = await discoverDroidModelEntries({ binaryPath: probe.binaryPath, timeoutMs });
  return {
    models: entries.map((entry) => ({ id: entry.id, label: entry.label || entry.id })),
    source: "help-text",
    fallbackUsed: false,
  };
}
