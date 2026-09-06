import { spawn, type ChildProcess } from "node:child_process";

const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Run a one-shot `droid <args>` and resolve to the exit code.
 *
 * FNXC:CliRuntime 2026-06-15-07:35:
 * Third-party CLI presence/auth probes must be non-blocking in Fusion request and session-startup paths. Use spawn-based probes here because synchronous shell probes freeze the dashboard event loop during CLI cold start.
 *
 * Why: a Droid CLI cold start can take 1–3s, occasionally longer. When droid-cli's
 * factory is invoked from a per-request createFnAgent path (Fusion dashboard
 * does this on every chat send), sync probes freeze every other request.
 * This async variant uses spawn so the loop keeps turning while the subprocess
 * starts up.
 *
 * FNXC:CliRuntime 2026-06-20-17:25:
 * FN-6808/FN-6801 require this fire-and-forget auth/presence probe to never reject. Catch synchronous spawn throws from the Vitest child-process guard or platform launch errors and resolve 127, matching the async error sentinel so callers degrade to unauthenticated/not-present instead of surfacing unhandled promise rejections.
 */
function runDroidProbe(args: string[], timeoutMs = 45000): Promise<number> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("droid", args, { stdio: "ignore" });
    } catch {
      resolve(127);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve(124);
    }, timeoutMs);
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/**
 * Async, non-blocking variant of validateCliPresence.
 * Resolves with `{ok: true}` on success, `{ok: false, error}` on failure —
 * never rejects, so callers can fire-and-forget without unhandled rejections.
 */
export async function validateCliPresenceAsync(): Promise<
  { ok: true } | { ok: false; error: Error }
> {
  const code = await runDroidProbe(["--version"]);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error: new Error(
      "Droid CLI not found on PATH. Install Droid CLI and sign in interactively with droid",
    ),
  };
}

export interface DroidModelEntry {
  id: string;
  label: string;
}

/**
 * Parse model entries (id + human label) out of `droid exec --help`. The help
 * text lists the catalog under `Available Models:` and `Custom Models:` headers,
 * each entry indented as `  <model-id>   <description>`. The trailing
 * `Model details:` section (lines like `  - Claude Opus 4.8: ...`) is
 * intentionally excluded — those are prose, not IDs. Exported for unit testing.
 */
export function parseDroidModelEntriesFromHelp(helpText: string): DroidModelEntry[] {
  const entries: DroidModelEntry[] = [];
  const seen = new Set<string>();
  let collecting = false;
  for (const line of helpText.split(/\r?\n/)) {
    // Section header at column 0, e.g. "Available Models:" / "Custom Models:".
    if (/^[A-Za-z][A-Za-z ]*Models:\s*$/.test(line)) {
      collecting = true;
      continue;
    }
    // Any other non-indented, non-empty line ends the current section
    // (notably "Model details:").
    if (collecting && line.trim() && !/^\s/.test(line)) {
      collecting = false;
    }
    if (!collecting) continue;
    // Indented "  <id>   <description>"; the id is the first whitespace-delimited
    // token (handles `custom:CC:-Opus-4.6-(Max)-0` and the like — no spaces).
    const match = line.match(/^\s+(\S+)\s{2,}(.+)$/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    // Strip a trailing "(default)" marker so the picker label reads
    // "GPT-5.6 Sol", not "GPT-5.6 Sol (default)"; keep any other parenthetical
    // (e.g. "(Max)") verbatim. Fall back to the id when stripping empties the label.
    const label = match[2].trim().replace(/\s*\(default\)\s*$/i, "") || id;
    entries.push({ id, label });
  }
  return entries;
}

/**
 * Parse model IDs out of `droid exec --help`. The help text lists the catalog
 * under `Available Models:` and `Custom Models:` headers, each entry indented as
 * `  <model-id>   <description>`. The trailing `Model details:` section (lines
 * like `  - Claude Opus 4.8: ...`) is intentionally excluded — those are prose,
 * not IDs. Exported for unit testing.
 */
export function parseDroidModelsFromHelp(helpText: string): string[] {
  return parseDroidModelEntriesFromHelp(helpText).map((entry) => entry.id);
}

export interface DroidDiscoveryOptions {
  /** Explicit binary path override; blank/undefined resolves the bare `droid` command via PATH. */
  binaryPath?: string;
  /** Wall-clock bound for the help-catalog spawn; defaults to DROID_MODEL_DISCOVERY_TIMEOUT_MS. */
  timeoutMs?: number;
}

function resolveDiscoveryBinaryPath(options?: DroidDiscoveryOptions): string {
  const trimmed = options?.binaryPath?.trim();
  return trimmed ? trimmed : "droid";
}

function resolveDiscoveryTimeout(options?: DroidDiscoveryOptions): number {
  return options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DROID_MODEL_DISCOVERY_TIMEOUT_MS;
}

/**
 * Spawn `droid exec --help` once and parse the model catalog entries from it.
 * Shared by `discoverDroidModels` (ids only) and `discoverDroidModelEntries`
 * (ids + labels); both must never throw and always settle.
 */
async function runDroidHelpCatalog(options?: DroidDiscoveryOptions): Promise<DroidModelEntry[]> {
  // The droid CLI has no `models`/`model list` command — those parse as a
  // *prompt* and launch a hung agent session. The catalog is printed by
  // `droid exec --help` (and exits cleanly).
  return new Promise<DroidModelEntry[]>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(resolveDiscoveryBinaryPath(options), ["exec", "--help"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }

    // FNXC:CliRuntime 2026-06-21: keep discovery bounded. `droid exec --help`
    // exits on its own, but a SIGKILL-on-timeout guard ensures a wedged spawn
    // can never leak (the prior `droid models` form launched a persistent
    // stream-jsonrpc backend that never exited, piling up into a process storm
    // because the dashboard re-loads this extension per chat-send).
    let settled = false;
    const settle = (value: DroidModelEntry[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!proc.killed) proc.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve(value);
    };
    const timer = setTimeout(() => settle([]), resolveDiscoveryTimeout(options));

    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once("error", () => settle([]));
    proc.once("exit", () => settle(parseDroidModelEntriesFromHelp(out)));
  });
}

/**
 * Discover Droid model entries (id + label) via the `droid exec --help`
 * catalog. Never throws; an unavailable or wedged binary degrades to [].
 */
export async function discoverDroidModelEntries(options?: DroidDiscoveryOptions): Promise<DroidModelEntry[]> {
  return runDroidHelpCatalog(options);
}

export async function discoverDroidModels(options?: DroidDiscoveryOptions): Promise<string[]> {
  const entries = await runDroidHelpCatalog(options);
  return entries.map((entry) => entry.id);
}
