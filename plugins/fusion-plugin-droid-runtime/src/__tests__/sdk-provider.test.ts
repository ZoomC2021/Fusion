import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PiContext } from "../prompt-builder.js";
const state = vi.hoisted(() => ({
  create: vi.fn(), connect: vi.fn(), close: vi.fn(), construct: vi.fn(),
  listTools: vi.fn(), settings: vi.fn(), interrupt: vi.fn(), sessionClose: vi.fn(), stream: vi.fn(),
}));
vi.mock("@factory/droid-sdk/node", async (original) => {
  const actual = await original<object>();
  return { ...actual, createSession: state.create,
    ProcessTransport: class {
      constructor(options: unknown) { state.construct(options); }
      connect = state.connect;
      close = state.close;
    },
  };
});
import { streamViaSdk, killAllSdkSessions } from "../sdk-provider.js";
const model = { id: "glm-5.3-flash", provider: "droid-cli", api: "droid-cli" } as Model<Api>;
const context: PiContext = { systemPrompt: "operator rules", messages: [{ role: "user", content: "hello" }] };
const session = { listTools: state.listTools, updateSettings: state.settings, interrupt: state.interrupt, close: state.sessionClose, stream: state.stream };
async function collect(ctx = context, options: Parameters<typeof streamViaSdk>[2] = {}) {
  const stream = streamViaSdk(model, ctx, options);
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  await vi.waitFor(() => expect(state.close).toHaveBeenCalled());
  return { result, events };
}
beforeEach(() => {
  vi.resetAllMocks();
  state.connect.mockResolvedValue(undefined);
  state.close.mockResolvedValue(undefined);
  state.create.mockResolvedValue(session);
  state.listTools.mockResolvedValue([{ id: "Bash" }, { id: "Read" }]);
  state.settings.mockResolvedValue(undefined);
  state.interrupt.mockResolvedValue(undefined);
  state.sessionClose.mockResolvedValue(undefined);
  state.stream.mockImplementation(async function* () { yield { type: "result", success: true }; });
});
afterEach(() => { killAllSdkSessions(); vi.useRealTimers(); delete process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS; });
it("uses a fresh session, full history, configured cwd and binary, and disables native tools", async () => {
  const ctx = { ...context, messages: [...context.messages, { role: "assistant", content: "previous" }, { role: "toolResult", toolName: "host", content: "tool output" }] };
  const { result } = await collect(ctx, { cwd: "/workspace", binaryPath: "/bin/droid", sessionId: "host-session" });
  expect(result.stopReason).toBe("stop");
  expect(state.construct).toHaveBeenCalledWith({ droidExecPath: "/bin/droid", cwd: "/workspace" });
  expect(state.create.mock.calls[0][0]).toMatchObject({ modelId: "glm-5.3-flash", autonomyLevel: "off", disableBuiltinSkills: true, autoRejectPermissionRequests: true, mcpServers: [] });
  expect(state.settings).toHaveBeenCalledWith({ restrictToolIds: [], disabledToolIds: ["Bash", "Read"] });
  expect(state.stream.mock.calls[0][0]).toContain(JSON.stringify(ctx.messages));
});
it("intercepts every declared host tool including built-ins, then removes private schemas", async () => {
  const ctx = { ...context, tools: [{ name: "bash", description: "host shell", parameters: { type: "object", properties: { command: { type: "string" } } } }] };
  let schemaPath = "";
  state.create.mockImplementation(async (options) => {
    schemaPath = options.mcpServers[0].args[2];
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))[0].inputSchema).toEqual(ctx.tools[0].parameters);
    expect(options.mcpServers[0].name.length).toBeLessThanOrEqual(32);
    const name = `${options.mcpServers[0].name.slice(0, 32)}___bash`;
    state.listTools.mockResolvedValue([{ id: "Bash" }, { id: name }, { id: "mcp__other__bash" }, { id: "ToolSearch" }]);
    state.stream.mockImplementation(async function* () {
      yield { type: "tool_call", name: "ToolSearch", input: { query: `select:${name}` } };
      yield { type: "tool_call", name, input: { command: "pwd" }, toolUseId: "call_1" };
      throw new Error("continued into autonomous execution");
    });
    return session;
  });
  const { result } = await collect(ctx);
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toContainEqual({ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pwd" } });
  expect(state.interrupt).toHaveBeenCalledOnce();
  expect(state.settings.mock.calls[0][0].restrictToolIds).toHaveLength(2);
  expect(state.settings.mock.calls[0][0].restrictToolIds).toContain("ToolSearch");
  expect(state.settings.mock.calls[0][0].disabledToolIds).toEqual(["Bash", "mcp__other__bash"]);
  await vi.waitFor(() => expect(existsSync(schemaPath)).toBe(false));
});
it.each([
  { events: [], message: "without a successful result" },
  { events: [{ type: "assistant_text_delta", text: "partial" }], message: "without a successful result" },
  { events: [{ type: "result", success: false, error: { message: "failed" } }], message: "failed" },
  { events: [{ type: "tool_call", name: "Bash", input: {} }], message: "undeclared tool" },
])("rejects incomplete, failed, and undeclared-tool turns %#", async ({ events, message }) => {
  state.stream.mockImplementation(async function* () { yield* events; });
  const { result, events: output } = await collect();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain(message);
  expect(output.some((event) => event.type === "done")).toBe(false);
});
it("preserves exact text deltas, thinking, and token usage", async () => {
  state.stream.mockImplementation(async function* () {
    yield { type: "thinking_text_delta", text: "reason" };
    yield { type: "assistant_text_delta", text: "a." };
    yield { type: "assistant_text_delta", text: "Com" };
    yield { type: "result", success: true, tokenUsage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheCreationTokens: 5 } };
  });
  const { result } = await collect();
  expect(result.content).toEqual([{ type: "thinking", thinking: "reason" }, { type: "text", text: "a.Com" }]);
  expect(result.usage).toMatchObject({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14 });
});
it("never starts a pre-aborted request", async () => {
  const signal = AbortSignal.abort(new Error("cancelled"));
  const result = await streamViaSdk(model, context, { signal }).result();
  expect(result.stopReason).toBe("aborted");
  expect(state.construct).not.toHaveBeenCalled();
});
it("cleans up failed connections", async () => {
  state.connect.mockRejectedValue(new Error("connection failed"));
  const { result } = await collect();
  expect(result.stopReason).toBe("error");
  expect(state.create).not.toHaveBeenCalled();
});
it.each(["abort", "timeout", "teardown"])("closes a pending transport on %s", async (mode) => {
  vi.useFakeTimers();
  process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS = "25";
  const controller = new AbortController();
  let rejectConnect: (error: Error) => void = () => {};
  state.connect.mockImplementation(() => new Promise((_, reject) => { rejectConnect = reject; }));
  state.close.mockImplementation(async () => { rejectConnect(new Error("closed")); });
  const stream = streamViaSdk(model, context, { signal: controller.signal });
  if (mode === "abort") controller.abort(new Error("user cancelled"));
  else if (mode === "teardown") killAllSdkSessions();
  else await vi.advanceTimersByTimeAsync(26);
  const result = await stream.result();
  expect(result.stopReason).toBe(mode === "abort" ? "aborted" : "error");
  expect(state.close).toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});
it("rejects image input explicitly before creating a process", async () => {
  const result = await streamViaSdk(model, { messages: [{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }] }] }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("image input");
  expect(state.construct).not.toHaveBeenCalled();
});
