import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDevinMcpConfig } from "../mcp-config.js";
it("isolates the bridge config while retaining existing servers and user settings", async () => {
  const source = await mkdtemp(join(tmpdir(), "fusion-devin-config-test-"));
  await mkdir(join(source, "devin"));
  const original = JSON.stringify({ mcpServers: { existing: { command: "existing" } } });
  await writeFile(join(source, "devin", "mcp_config.json"), original);
  await writeFile(join(source, "devin", "config.json"), '{"version":1}');
  const config = await createDevinMcpConfig({ name: "fusion-custom-tools", command: "node", args: ["schema.cjs"], env: [{ name: "TEST_TOKEN", value: "secret" }] }, source);
  try {
    const generated = JSON.parse(await readFile(join(config.env.XDG_CONFIG_HOME, "devin", "mcp_config.json"), "utf8"));
    expect(generated.mcpServers.existing).toEqual({ command: "existing" });
    expect(generated.mcpServers["fusion-custom-tools"]).toMatchObject({ command: "node", transport: "stdio", env: { TEST_TOKEN: "secret" } });
    expect(await readFile(join(config.env.XDG_CONFIG_HOME, "devin", "config.json"), "utf8")).toBe('{"version":1}');
    expect(await readFile(join(source, "devin", "mcp_config.json"), "utf8")).toBe(original);
  } finally { await config.dispose(); await rm(source, { recursive: true, force: true }); }
  await expect(stat(config.env.XDG_CONFIG_HOME)).rejects.toMatchObject({ code: "ENOENT" });
});
