import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startFusionToolBridge, type ToolLike } from "@fusion-plugin-examples/acp-runtime/tool-bridge";

export interface ScopedMcp {
  configPath: string;
  targetPath: string;
  dispose: () => Promise<void>;
}

/** Mount only the MCP file in the child's mount namespace; never edit global configuration. */
export async function startScopedMcp(tools: ToolLike[], serverKey: string, signal: AbortSignal, environment = { platform: process.platform, home: homedir(), bubblewrap: "/usr/bin/bwrap" }): Promise<ScopedMcp> {
  signal.throwIfAborted();
  if (environment.platform !== "linux") throw new Error("Antigravity host tools require Linux with Bubblewrap until upstream supports per-run MCP configuration.");
  await access(environment.bubblewrap, constants.X_OK);
  // Refuse a missing target: creating a mountpoint through the shared root could write to the host.
  const targetPath = await realpath(join(environment.home, ".gemini", "config", "mcp_config.json"));
  const bridge = await startFusionToolBridge(tools.map(tool => ({
    ...tool,
    execute: tool.execute ? (id, args, bridgeSignal, update, ctx) => {
      signal.throwIfAborted();
      return tool.execute!(id, args, bridgeSignal ? AbortSignal.any([signal, bridgeSignal]) : signal, update, ctx);
    } : undefined,
  })));
  if (!bridge || bridge.toolCount !== tools.length) {
    await bridge?.dispose();
    throw new Error("Antigravity could not expose every requested host tool.");
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "fusion-agy-mcp-"));
    const configPath = join(directory, "mcp_config.json");
    const entry = bridge.mcpServer;
    await writeFile(configPath, JSON.stringify({ mcpServers: { [serverKey]: {
      command: entry.command, args: entry.args,
      env: Object.fromEntries(entry.env.map(item => [item.name, item.value])),
    } } }), { mode: 0o600 });
    signal.throwIfAborted();
    const ownedDirectory = directory;
    return { configPath, targetPath, dispose: async () => {
      await Promise.allSettled([bridge.dispose(), rm(ownedDirectory, { recursive: true, force: true })]);
    } };
  } catch (error) {
    await Promise.allSettled([bridge.dispose(), directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()]);
    throw error;
  }
}
