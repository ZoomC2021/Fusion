import { superviseSpawn } from "@fusion/core";

export interface DevinCliProbe { binary: { available: boolean; version?: string; reason?: string }; authenticated: boolean }
let cached: { at: number; value: DevinCliProbe } | undefined;
let pending: Promise<DevinCliProbe> | undefined;
function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const managed = superviseSpawn("devin", args, { stdio: ["ignore", "pipe", "pipe"], maxLifetimeMs: 6000 });
    let text = "";
    const timer = setTimeout(() => { managed.kill("SIGKILL"); reject(new Error("Devin CLI status timed out")); }, 5000);
    managed.child.stdout?.on("data", chunk => { text = (text + String(chunk)).slice(0, 16_000); });
    managed.child.stderr?.on("data", () => undefined);
    managed.child.once("error", error => { clearTimeout(timer); reject(error); });
    managed.child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(text); else reject(new Error("Devin CLI status unavailable")); });
  });
}
/* FNXC:DevinCli 2026-09-06-04:47: Only explicit dashboard requests probe the CLI.
 * Share concurrent requests, bound both subprocesses, and never expose auth output.
 */
export function probeDevinCli(refresh = false): Promise<DevinCliProbe> {
  if (pending) return pending;
  if (!refresh && cached && Date.now() - cached.at < 30_000) return Promise.resolve(cached.value);
  pending = (async () => {
    let value: DevinCliProbe;
    try {
      const version = (await run(["version"])).trim().split("\n")[0];
      const auth = await run(["auth", "status"]).catch(() => "");
      value = { binary: { available: true, version }, authenticated: /^Logged in\b/m.test(auth) };
    } catch { value = { binary: { available: false, reason: "Devin CLI is unavailable on the Fusion server PATH." }, authenticated: false }; }
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => { pending = undefined; });
  return pending;
}
