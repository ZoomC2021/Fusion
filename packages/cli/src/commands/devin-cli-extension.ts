import { createRequire } from "node:module";
import { reconcileDevinCliPaths } from "@fusion/core";

/* FNXC:DevinCli 2026-09-06-04:47: Dashboard and daemon registries use the same
 * vendored-provider precedence and Off behavior as executor pi sessions.
 */
export function resolveDevinCliExtensions(paths: readonly string[], settings: { useDevinCli?: boolean }): string[] {
  let entry: string | null = null;
  try { entry = createRequire(import.meta.url).resolve("@fusion/devin-cli"); } catch { /* optional local package */ }
  return reconcileDevinCliPaths(paths, entry, settings.useDevinCli !== false);
}
