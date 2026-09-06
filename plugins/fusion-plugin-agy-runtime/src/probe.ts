import { runAgyCommand } from "./cli-spawn.js";
import { parseAgyModelLines } from "./process-manager.js";
import type { AgyBinaryStatus } from "./types.js";

const CANDIDATES = ["agy"] as const;
const MAX_FAILURE_DETAIL_LENGTH = 180;

function buildCandidates(binaryPath?: string): { candidates: string[]; configuredBinaryPath?: string } {
  const configuredBinaryPath = binaryPath?.trim() || undefined;
  const ordered = configuredBinaryPath ? [configuredBinaryPath, ...CANDIDATES] : [...CANDIDATES];
  return { candidates: Array.from(new Set(ordered)), configuredBinaryPath };
}

function summarizeFailure(binary: string, stdout: string, stderr: string): string | undefined {
  const detail = `${stderr || stdout}`.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  const truncated = detail.length > MAX_FAILURE_DETAIL_LENGTH ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…` : detail;
  return `${binary}: ${truncated}`;
}

/*
FNXC:AgyCli 2026-09-06-00:00:
agy has no `status`/`whoami` subcommand. Authentication is inferred from
`agy models`: it fetches the model catalog from the backend, so an exit 0 with
≥1 model means the stored token (in the OS keyring) is usable. Fail closed to
authenticated:false with an actionable reason on nonzero exit / empty output /
timeout. A keyring/secret-service lock surfaces as a distinct reason. We run
the command directly (rather than via discoverAgyModels) so stderr is available
for keyring detection.
*/
function looksLikeKeyringLock(stderr: string): boolean {
  const combined = stderr.toLowerCase();
  return combined.includes("keyring") || combined.includes("secret service") || combined.includes("secret-service");
}

async function probeAgyAuth(binary: string, timeoutMs: number): Promise<{ authenticated: boolean; reason?: string }> {
  const res = await runAgyCommand(binary, ["models"], timeoutMs);
  if (res.code !== 0) {
    return { authenticated: false, reason: looksLikeKeyringLock(res.stderr) ? "OS keyring/secret-service is locked or unavailable" : "agy models did not return any models (not authenticated or backend unreachable)" };
  }
  const models = parseAgyModelLines((res.stdout || "").trim());
  if (models.length > 0) return { authenticated: true };
  return { authenticated: false, reason: looksLikeKeyringLock(res.stderr) ? "OS keyring/secret-service is locked or unavailable" : "agy models did not return any models (not authenticated or backend unreachable)" };
}

export async function probeAgyBinary(options?: { timeoutMs?: number; binaryPath?: string }): Promise<AgyBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const { candidates, configuredBinaryPath } = buildCandidates(options?.binaryPath);
  const failureDetails: string[] = [];

  for (const binary of candidates) {
    const version = await runAgyCommand(binary, ["--version"], timeoutMs);
    const failureDetail = summarizeFailure(binary, version.stdout, version.stderr);
    if (failureDetail) failureDetails.push(failureDetail);
    const common = {
      binaryName: binary,
      binaryPath: binary,
      configuredBinaryPath,
      usingConfiguredBinaryPath: configuredBinaryPath === binary,
      diagnostics: failureDetails.length > 0 ? [...failureDetails] : undefined,
      probeDurationMs: Date.now() - startedAt,
    };
    if (version.code === 0) {
      const auth = await probeAgyAuth(binary, timeoutMs);
      return {
        available: true,
        authenticated: auth.authenticated,
        ...common,
        version: version.stdout.trim() || undefined,
        reason: auth.authenticated ? undefined : auth.reason,
      };
    }

    const combined = `${version.stdout}\n${version.stderr}`.toLowerCase();
    if (combined.includes("keyring") || combined.includes("secret service") || combined.includes("secret-service")) {
      return {
        available: true,
        authenticated: false,
        ...common,
        reason: "OS keyring/secret-service is locked or unavailable",
      };
    }
  }

  const baseReason = configuredBinaryPath
    ? `Configured agy CLI binary '${configuredBinaryPath}' failed; PATH fallback agy also failed`
    : "agy not found on PATH";
  return {
    available: false,
    authenticated: false,
    configuredBinaryPath,
    usingConfiguredBinaryPath: false,
    diagnostics: failureDetails.length > 0 ? failureDetails : undefined,
    reason: failureDetails.length > 0 ? `${baseReason} (${failureDetails.join("; ")})` : baseReason,
    probeDurationMs: Date.now() - startedAt,
  };
}
