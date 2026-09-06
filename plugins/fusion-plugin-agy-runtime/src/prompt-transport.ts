import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import { assertCmdBoundarySafe, classifyWindowsLaunchTarget, quoteCmdArgument, resolveAgyBinaryForSpawn, resolvePowerShellExecutable } from "./cli-spawn.js";
import { parseAgyStreamLine } from "./stream-parser.js";

const FIRST_LINE_DEFAULT_MS = 60_000;
const INACTIVITY_DEFAULT_MS = 120_000;
const STDERR_MAX = 16_384;
function timeout(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; }

export interface AgyPromptCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
}

export interface AgyPromptInput extends AgyPromptCallbacks {
  binary?: string;
  model?: string;
  cwd: string;
  tools?: "coding" | "readonly";
  prompt: string;
  conversationId?: string;
  signal?: AbortSignal;
}

export interface AgyPromptResult {
  conversationId?: string;
  text: string;
  usage?: unknown;
}

export interface AgyPromptDependencies {
  supervise?: typeof superviseSpawn;
  taskkill?: typeof spawn;
  platform?: NodeJS.Platform;
  resolvePowerShell?: () => string;
}

/*
FNXC:AgyCli 2026-09-06-00:00:
Streaming agy turns are supervised rather than using the probe's shell runner.
The prompt is a single NDJSON user event on stdin, then stdin is closed; agy
runs one turn per spawned process. Direct targets eliminate cmd, while cmd
shims reject unsafe tokens before verbatim quoting. This preserves task-worktree
autonomy and prevents a long-running agent from outliving Fusion.
*/
export async function launchAgyPrompt(input: AgyPromptInput, deps: AgyPromptDependencies = {}): Promise<AgyPromptResult> {
  if (!input.cwd || !existsSync(input.cwd)) throw new Error(`agy CLI requires an existing session cwd: ${input.cwd || "(missing)"}`);
  const platform = deps.platform ?? process.platform;
  const configuredBinary = input.binary?.trim() || undefined;
  const target = resolveAgyBinaryForSpawn(configuredBinary || "agy");
  const model = (input.model || "gemini-3.7-flash-high").replace(/^agy-cli\//, "");
  const args = ["--dangerously-skip-permissions", "--mode", input.tools === "coding" ? "accept-edits" : "plan", "--model", model, "--input-format", "stream-json", "--output-format", "stream-json"];
  if (input.conversationId) args.push("--conversation", input.conversationId);
  /*
  FNXC:AgyCli 2026-09-06-00:00:
  An agy turn is bounded by first output and reset-on-output inactivity, not a
  total duration. Gemini 3.7 Flash cold-starts in ~5-8s plus thinking before the
  first token, so the first-line default is 60s. Active coding turns may stream
  beyond two minutes, so disable the supervisor lifetime cap while retaining
  parent-shutdown supervision and explicit teardown.
  */
  const options = { shell: false as const, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], cwd: input.cwd, maxLifetimeMs: Number.POSITIVE_INFINITY };
  const supervise = deps.supervise ?? superviseSpawn;
  let command = target; let launchArgs = args; let launchOptions: Parameters<typeof superviseSpawn>[2] = options;
  if (platform === "win32") {
    const classification = classifyWindowsLaunchTarget(target);
    if (classification === "unsupported") throw new Error(`agy CLI resolved target ${target} has unsupported ${path.extname(target)} extension; point agyCliBinaryPath at the agy executable.`);
    if (classification === "cmd-shim") {
      [target, ...args].forEach(assertCmdBoundarySafe);
      const commandLine = [quoteCmdArgument(target), ...args.map(quoteCmdArgument)].join(" ");
      const configured = process.env.ComSpec;
      const comspec = configured && path.isAbsolute(configured) && path.basename(configured).toLowerCase() === "cmd.exe" && !configured.includes('"') ? configured : "cmd.exe";
      if (comspec.length + commandLine.length > 8000) throw new Error(`agy cmd command line length ${comspec.length + commandLine.length} exceeds 8000 characters for ${target}.`);
      command = comspec; launchArgs = ["/d", "/s", "/c", `"${commandLine}"`]; launchOptions = { ...options, windowsVerbatimArguments: true };
    } else if (classification === "powershell-shim") {
      command = (deps.resolvePowerShell ?? resolvePowerShellExecutable)();
      launchArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", target, ...args];
    }
  }
  let supervised: SupervisedChild;
  try {
    supervised = supervise(command, launchArgs, launchOptions);
  } catch (error) {
    throw new Error(`agy CLI spawn failed for ${target} (${platform === "win32" ? classifyWindowsLaunchTarget(target) : "direct"}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const child = supervised.child;
  let settled = false, sawResult = false, output = "", conversationId: string | undefined, usage: unknown, stderr = "", teardownReason: string | undefined;
  let firstTimer: NodeJS.Timeout | undefined; let inactivityTimer: NodeJS.Timeout | undefined;
  const teardown = (reason: string) => {
    if (teardownReason || child.exitCode !== null || child.signalCode !== null) return;
    teardownReason = reason;
    if (platform === "win32" && typeof supervised.pid === "number") {
      try {
        (deps.taskkill ?? spawn)("taskkill", ["/pid", String(supervised.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
      } catch {
        // FNXC:AgyCli 2026-09-06-00:00: taskkill can be absent; supervisor teardown still reaps the launcher.
      }
      supervised.kill();
    } else supervised.kill("SIGKILL");
  };
  return new Promise<AgyPromptResult>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (firstTimer) clearTimeout(firstTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (input.signal) input.signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve({ conversationId, text: output, usage });
    };
    const resetInactivity = () => { if (inactivityTimer) clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => { teardown("agy CLI inactivity timeout"); finish(new Error("agy CLI inactivity timeout")); }, timeout("PI_AGY_CLI_TIMEOUT_MS", INACTIVITY_DEFAULT_MS)); };
    const abort = () => { teardown("agy CLI aborted"); finish(new Error("agy CLI aborted")); };
    firstTimer = setTimeout(() => { teardown("agy CLI first-line timeout"); finish(new Error("agy CLI first-line timeout")); }, timeout("PI_AGY_CLI_FIRST_LINE_TIMEOUT_MS", FIRST_LINE_DEFAULT_MS));
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr = (stderr + String(chunk)).slice(-STDERR_MAX); });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") finish(error); });
    const lines = readline.createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = undefined; }
      resetInactivity();
      const event = parseAgyStreamLine(line);
      // FNXC:AgyCli 2026-09-06-00:00: treat an empty-string conversation_id as absent (the result-error fixture emits conversation_id "") so it cannot clobber the id captured from init.
      if (event.kind === "system-init") conversationId = event.conversationId || conversationId;
      if (event.kind === "assistant-text") { output += event.text; input.onText?.(event.text); }
      if (event.kind === "tool-call-started") input.onToolStart?.(event.name, event.args);
      if (event.kind === "tool-call-completed") input.onToolEnd?.(event.name, event.isError, event.result);
      if (event.kind === "result") {
        sawResult = true;
        conversationId = event.conversationId || conversationId;
        usage = event.usage;
        // FNXC:AgyCli 2026-09-06-00:00: agy's result.response is the canonical full reply; fall back to it when no assistant text_delta was streamed.
        if (event.text && !output) { output = event.text; input.onText?.(event.text); }
        if (event.isError) finish(new Error(`agy CLI reported an error: ${event.error ?? event.text ?? "unknown error"}`));
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(`agy CLI spawn failed for ${target}: ${error.message}`));
    });
    child.once("close", (code: number | null) => {
      if (teardownReason) return finish(new Error(teardownReason));
      if (code !== 0) return finish(new Error(`agy CLI exited ${code}: ${stderr}`));
      if (!sawResult) return finish(new Error("agy CLI stream ended without a result event."));
      finish();
    });
    try {
      const payload = `${JSON.stringify({ event: "user", message: { content: input.prompt } })}\n`;
      child.stdin?.end(payload);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
