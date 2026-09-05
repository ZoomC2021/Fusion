import { discoverAgyModels } from "./process-manager.js";
import { probeAgyBinary } from "./probe.js";

function normalizeDiscoveryOptions(options?: unknown): { binaryPath?: string; timeoutMs?: number } {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return {
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : undefined,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

export async function discoverAgyProviderModels(options?: unknown) {
  const probe = await probeAgyBinary(normalizeDiscoveryOptions(options));
  if (!probe.available || !probe.binaryName) {
    return { models: [], source: "probe", fallbackUsed: true, reason: probe.reason ?? "binary unavailable" };
  }
  const result = await discoverAgyModels(probe.binaryPath ?? probe.binaryName);
  return {
    models: result.models.map((entry) => ({ id: entry.id, label: entry.label })),
    source: result.source,
    fallbackUsed: result.fallbackUsed,
    reason: result.reason,
  };
}
