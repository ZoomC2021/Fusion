import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as host from "@fusion-plugin-examples/acp-runtime/tool-bridge";
import { startScopedMcp } from "../scoped-mcp.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agy-mcp-test-")); roots.push(home);
  await mkdir(join(home,".gemini/config"), {recursive:true});
  const target = join(home,".gemini/config/mcp_config.json");
  await writeFile(target, '{"mcpServers":{"operator":{}}}');
  return {target, environment:{home, platform:"linux" as const, bubblewrap:process.execPath}};
}
it("isolates parallel bridge configs, preserves host bytes, and removes owned secrets", async () => {
  const {target,environment} = await fixture();
  const dispose = vi.fn().mockResolvedValue(undefined);
  const start = vi.spyOn(host,"startFusionToolBridge").mockResolvedValue({toolCount:1,dispose,mcpServer:{name:"host",command:"node",args:["bridge"],env:[{name:"TOKEN",value:"private"}]}});
  const signal = new AbortController();
  const execute = vi.fn();
  const a = await startScopedMcp([{name:"fn_done",execute}],"session-a",signal.signal,environment);
  const b = await startScopedMcp([{name:"fn_done",execute}],"session-b",signal.signal,environment);
  expect(a.configPath).not.toBe(b.configPath);
  expect(Object.keys(JSON.parse(await readFile(a.configPath,"utf8")).mcpServers)).toEqual(["session-a"]);
  expect((await stat(a.configPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(target,"utf8")).toBe('{"mcpServers":{"operator":{}}}');
  signal.abort();
  expect(() => start.mock.calls[0][0]![0].execute!("id",{})).toThrow();
  expect(execute).not.toHaveBeenCalled();
  await a.dispose(); await b.dispose();
  await expect(stat(a.configPath)).rejects.toMatchObject({code:"ENOENT"});
  expect(dispose).toHaveBeenCalledTimes(2);
});
it("refuses missing global mount targets and unsupported hosts before opening a bridge", async () => {
  const {target,environment} = await fixture();
  const start = vi.spyOn(host,"startFusionToolBridge");
  await expect(startScopedMcp([],"s",new AbortController().signal,{...environment,platform:"darwin"})).rejects.toThrow("Linux");
  await rm(target);
  await expect(startScopedMcp([],"s",new AbortController().signal,environment)).rejects.toMatchObject({code:"ENOENT"});
  expect(start).not.toHaveBeenCalled();
});
it("closes a partial bridge rather than silently dropping unsupported tools", async () => {
  const {environment} = await fixture();
  const dispose = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(host,"startFusionToolBridge").mockResolvedValue({toolCount:0,dispose,mcpServer:{name:"host",command:"node",args:[],env:[]}});
  await expect(startScopedMcp([{name:"read",execute:vi.fn()}],"s",new AbortController().signal,environment)).rejects.toThrow("every requested host tool");
  expect(dispose).toHaveBeenCalledOnce();
});
