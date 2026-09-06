import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model, AssistantMessageEventStream } from "@earendil-works/pi-ai";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), save: vi.fn(), release: vi.fn(), acquire: vi.fn(), bridge: vi.fn(), dispose: vi.fn(), configDispose: vi.fn(), enabled: true }));
vi.mock("@fusion/core", () => ({ superviseSpawn: (...args: unknown[]) => { const child = mocks.spawn(...args); return { child, kill: child.kill }; }, GlobalSettingsStore: class { async getSettings() { return { useDevinCli: mocks.enabled }; } } }));
vi.mock("../mcp-config.js", () => ({ createDevinMcpConfig: vi.fn().mockResolvedValue({ env: {}, dispose: mocks.configDispose }) }));
vi.mock("../sessions.js", () => ({ acquireSession: mocks.acquire, pruneSessions: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@fusion-plugin-examples/acp-runtime/tool-bridge", () => ({ startFusionToolBridge: mocks.bridge }));
import register, { discoverDevinModels } from "../../index.js";

type Config = { models: Array<{ id: string }>; streamSimple: (model: Model<Api>, context: unknown, options: object) => AssistantMessageEventStream };
let config: Config;
let calls: Array<{ method: string; params: Record<string, unknown> }>;
let failures: Set<string>;
let silent: Set<string>;
let updates: object[];
let hostCall: { name: string; arguments: object } | undefined;
const model = { id: "glm-5-2", provider: "devin-cli" } as Model<Api>;
const context = { systemPrompt: "system", messages: [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "new" }] };
function setup(entry?: object) {
  mocks.read.mockResolvedValue(entry);
  return register({ registerProvider: (_id, value) => { config = value as Config; } });
}
function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable(), kill: vi.fn() });
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    const msg = JSON.parse(String(chunk)); calls.push(msg);
    queueMicrotask(() => {
      if (silent.has(msg.method)) return;
      const update = (value: object) => proc.stdout.write(JSON.stringify({ method: "session/update", params: { update: value } }) + "\n");
      if (msg.method === "session/load") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replay" } });
      if (msg.id !== undefined) {
        if (msg.method === "session/prompt" && !failures.has(msg.method)) {
          for (const value of updates) update(value);
          if (hostCall) {
            const tools = mocks.bridge.mock.lastCall![0];
            tools.find((tool: { name: string }) => tool.name === hostCall!.name).execute("call-1", hostCall.arguments);
            return;
          }
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "completed" } });
        }
        proc.stdout.write(JSON.stringify({ id: msg.id, ...(failures.has(msg.method) ? { error: { code: -32000, message: `${msg.method} rejected` } } : { result: msg.method === "session/new" ? { sessionId: "fresh" } : { stopReason: "end_turn" } }) }) + "\n");
      }
    }); done();
  } }); return proc;
}
async function run() { return config.streamSimple(model, context, { cwd: "/workspace", sessionId: "pi" }).result(); }
beforeEach(() => {
  vi.clearAllMocks(); calls = []; failures = new Set(); silent = new Set(); updates = []; hostCall = undefined; mocks.enabled = true;
  mocks.dispose.mockResolvedValue(undefined); mocks.configDispose.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation(fakeProcess); mocks.acquire.mockResolvedValue({ read: mocks.read, save: mocks.save, release: mocks.release });
  mocks.bridge.mockImplementation(async (tools: unknown[]) => tools.length ? { mcpServer: { name: "fusion" }, dispose: mocks.dispose } : null);
});
afterEach(() => { vi.useRealTimers(); });

describe("registration", () => {
  it("registers synchronously without spawning for repeated session factories", () => {
    expect(setup()).toBeUndefined(); expect(setup()).toBeUndefined(); expect(mocks.spawn).not.toHaveBeenCalled();
    expect(config.models.map(m => m.id)).toEqual(["glm-5-2", "swe-1-7", "swe-1-7-medium"]);
  });
  it("keeps models available after explicit discovery fails", async () => {
    mocks.spawn.mockImplementationOnce(() => { throw new Error("ENOENT"); });
    await expect(discoverDevinModels()).rejects.toThrow("ENOENT"); setup(); expect(config.models.length).toBeGreaterThan(0); expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("refuses new turns when disabled even with a cached provider", async () => {
    setup(); mocks.enabled = false; expect((await run()).errorMessage).toContain("disabled"); expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
describe("session recovery", () => {
  it("recovers rejected loads once with full context and persists the replacement", async () => {
    setup({ acpSessionId: "gone", cwd: "/workspace", model: model.id }); failures.add("session/load");
    expect((await run()).content).toEqual([{ type: "text", text: "completed" }]);
    expect(calls.filter(c => c.method === "session/new")).toHaveLength(1);
    expect(calls.find(c => c.method === "session/prompt")?.params.prompt).toEqual([{ type: "text", text: "<system>\nsystem\n</system>\n\nuser: old\n\nassistant: answer\n\nuser: new" }]);
    expect(mocks.save).toHaveBeenLastCalledWith({ acpSessionId: "fresh", cwd: "/workspace", model: model.id });
  });
  it("sends only the latest turn on a successful resume", async () => {
    setup({ acpSessionId: "saved", cwd: "/workspace", model: model.id }); expect((await run()).content).toEqual([{ type: "text", text: "completed" }]);
    expect(calls.some(c => c.method === "session/new")).toBe(false);
    expect(calls.find(c => c.method === "session/prompt")?.params.prompt).toEqual([{ type: "text", text: "new" }]);
  });
  it.each([undefined, { acpSessionId: "legacy" }, { acpSessionId: "other", cwd: "/other", model: model.id }, { acpSessionId: "other", cwd: "/workspace", model: "other" }])("starts fresh for missing or incompatible persistence: %j", async entry => {
    setup(entry); await run(); expect(calls.some(c => c.method === "session/load")).toBe(false); expect(calls.filter(c => c.method === "session/new")).toHaveLength(1);
  });
  it.each(["initialize", "session/prompt"])("does not replay failures in %s", async method => {
    setup({ acpSessionId: "saved", cwd: "/workspace", model: model.id }); failures.add(method);
    expect((await run()).errorMessage).toBe(`${method} rejected`); expect(calls.some(c => c.method === "session/new")).toBe(false); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not treat a timed-out load as a confirmed missing session", async () => {
    vi.useFakeTimers(); setup({ acpSessionId: "saved", cwd: "/workspace", model: model.id }); silent.add("session/load");
    const result = run(); await vi.advanceTimersByTimeAsync(120_000); expect((await result).errorMessage).toBe("session/load timed out after 120000ms");
    expect(calls.some(c => c.method === "session/new")).toBe(false); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("surfaces fresh-session failure without another retry", async () => {
    setup({ acpSessionId: "gone", cwd: "/workspace", model: model.id }); failures = new Set(["session/load", "session/new"]);
    expect((await run()).errorMessage).toBe("session/new rejected"); expect(calls.filter(c => c.method === "session/new")).toHaveLength(1);
  });
});
describe("Fusion handoff and activity", () => {
  it.each(["fn_run_verification", "fn_task_done"])("hands %s to pi exactly once and carries tool results into the next turn", async name => {
    setup(); hostCall = { name, arguments: { taskId: "FN-1" } };
    const tools = [{ name, description: name, parameters: { type: "object" } }];
    const output = await config.streamSimple(model, { ...context, tools }, { cwd: "/workspace", sessionId: "pi" }).result();
    expect(output.stopReason).toBe("toolUse"); expect(output.content).toEqual([{ type: "toolCall", id: "devin-fresh-call-1", name, arguments: { taskId: "FN-1" } }]);
    expect(calls.find(c => c.method === "session/new")?.params.mcpServers).toEqual([{ name: "fusion" }]);
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce(); expect(mocks.save).toHaveBeenCalledWith(undefined);
    hostCall = undefined; calls = [];
    await config.streamSimple(model, { ...context, tools, messages: [...context.messages, output, { role: "toolResult", toolCallId: "devin-fresh-call-1", toolName: name, content: [{ type: "text", text: "verified" }] }] }, { cwd: "/workspace", sessionId: "pi" }).result();
    expect(JSON.stringify(calls.find(c => c.method === "session/prompt")?.params)).toContain("verified");
  });
  it("emits thinking, native tool lifecycle and plan activity without pi tool calls", async () => {
    setup(); updates = [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } },
      { sessionUpdate: "tool_call", toolCallId: "native", title: "read file", kind: "read", rawInput: { path: "a" } },
      { sessionUpdate: "tool_call_update", toolCallId: "native", status: "completed" },
      { sessionUpdate: "plan_update", plan: { type: "markdown", content: "Updated plan" } },
      { sessionUpdate: "plan_removed" },
      { sessionUpdate: "plan", entries: [{ content: "Check file", status: "pending", priority: "medium" }] },
    ];
    const stream = config.streamSimple(model, context, { cwd: "/workspace" }); const events = [];
    for await (const event of stream) events.push(event);
    expect(events.some(e => e.type === "thinking_delta")).toBe(true);
    expect(events.some(e => e.type === "toolcall_end")).toBe(false);
    const output = await stream.result(); expect(JSON.stringify(output.content)).toContain("Tool completed"); expect(JSON.stringify(output.content)).toContain("Check file"); expect(JSON.stringify(output.content)).toContain("Updated plan"); expect(JSON.stringify(output.content)).toContain("Plan cleared");
    expect(events.filter(e => e.type === "text_start" || e.type === "thinking_start").every(e => typeof e.partial === "object" && "contentIndex" in e)).toBe(true);
  });
  it("releases the config and session lease when bridge disposal rejects", async () => {
    setup(); mocks.dispose.mockRejectedValueOnce(new Error("dispose failed"));
    const result = await config.streamSimple(model, { ...context, tools: [{ name: "fn_task_done", parameters: {} }] }, { sessionId: "pi" }).result();
    expect(result.errorMessage).toContain("cleanup failed");
    expect(mocks.configDispose).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("cancels an active turn and releases all resources", async () => {
    vi.useFakeTimers(); setup(); silent.add("session/prompt"); const controller = new AbortController();
    const stream = config.streamSimple(model, { ...context, tools: [{ name: "fn_task_done", parameters: {} }] }, { signal: controller.signal, sessionId: "pi" });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); expect((await stream.result()).stopReason).toBe("aborted");
    expect(calls.some(c => c.method === "session/cancel")).toBe(true); expect(mocks.dispose).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
  });
});
