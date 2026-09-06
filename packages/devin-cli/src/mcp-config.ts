import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm, cp, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { FusionToolBridge } from "@fusion-plugin-examples/acp-runtime/tool-bridge";

/* FNXC:DevinCli 2026-09-06-04:47:
 * Devin 3000.6.14 advertises ACP mcpServers but its native MCP tools only resolve
 * configured servers. Give each subprocess an isolated XDG config view with a
 * merged MCP file. Existing config directories remain linked, credentials stay
 * in the original data directory, and no user/project config is overwritten.
 */
export async function createDevinMcpConfig(server: FusionToolBridge["mcpServer"], source = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")) {
  const root = await mkdtemp(join(tmpdir(), "fusion-devin-config-"));
  const linkEntries = async (from: string, to: string, omit: string) => {
    for (const name of await readdir(from).catch(() => [])) {
      if (name === omit) continue;
      const original = join(from, name);
      const target = join(to, name);
      const directory = (await stat(original).catch(() => undefined))?.isDirectory();
      if (directory === undefined) continue;
      try { await symlink(original, target, directory ? "junction" : "file"); }
      catch (error) { if (process.platform !== "win32" || directory) throw error; await cp(original, target); }
    }
  };
  try {
    await linkEntries(source, root, "devin");
    const target = join(root, "devin"); await mkdir(target, { mode: 0o700 });
    await linkEntries(join(source, "devin"), target, "mcp_config.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    try { config = JSON.parse(await readFile(join(source, "devin", "mcp_config.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid Devin MCP config");
    if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) throw new Error("Invalid Devin MCP servers");
    await writeFile(join(target, "mcp_config.json"), JSON.stringify({ ...config, mcpServers: {
      ...config.mcpServers,
      [server.name]: { transport: "stdio", command: server.command, args: server.args, env: Object.fromEntries(server.env.map(item => [item.name, item.value])) },
    } }), { mode: 0o600 });
    return { env: { ...process.env, XDG_CONFIG_HOME: root }, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
