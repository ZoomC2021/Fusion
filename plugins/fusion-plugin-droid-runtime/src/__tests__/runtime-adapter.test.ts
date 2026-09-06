import { describe, expect, it, vi } from "vitest";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
vi.mock("../sdk-provider.js", () => ({ streamViaSdk: vi.fn() }));
import { streamViaSdk } from "../sdk-provider.js";
import { DroidRuntimeAdapter } from "../runtime-adapter.js";

function output(stopReason = "stop") {
  return { role: "assistant", content: [], api: "droid-cli", provider: "droid-cli", model: "model", stopReason, errorMessage: "failure", timestamp: 0,
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: {input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0} } } as any;
}

describe("DroidRuntimeAdapter", () => {
  it("consumes pi async events, preserves history, and uses configured workspace/binary", async () => {
    const onText = vi.fn(), onThinking = vi.fn();
    const adapter = new DroidRuntimeAdapter({ droidModel: "model", droidBinaryPath: "/bin/droid" });
    const { session } = await adapter.createSession({ cwd: "/workspace", systemPrompt: "sys", onText, onThinking });
    // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
    const stream = new AssistantMessageEventStream();
    vi.mocked(streamViaSdk).mockReturnValueOnce(stream);
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const pending = adapter.promptWithFallback(session, "hello", { images: [image] });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: output() });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "b", partial: output() });
    stream.push({ type: "done", reason: "stop", message: output() }); stream.end(); await pending;
    expect(onText).toHaveBeenCalledWith("a"); expect(onThinking).toHaveBeenCalledWith("b");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ content: [{ type: "text", text: "hello" }, image] });
    expect(streamViaSdk).toHaveBeenLastCalledWith(expect.objectContaining({ id: "model" }), expect.objectContaining({ systemPrompt: "sys" }), expect.objectContaining({ cwd: "/workspace", binaryPath: "/bin/droid" }));
    expect(adapter.describeModel(session)).toBe("droid/model");
  });
  it("rejects provider errors and lets disposal cancel the active request", async () => {
    const adapter = new DroidRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/workspace", systemPrompt: "sys" });
    // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
    const stream = new AssistantMessageEventStream(); vi.mocked(streamViaSdk).mockReturnValueOnce(stream);
    const pending = adapter.promptWithFallback(session, "hello");
    await expect(adapter.promptWithFallback(session, "overlap")).rejects.toThrow("active turn");
    const signal = vi.mocked(streamViaSdk).mock.calls.at(-1)![2]!.signal!;
    session.dispose(); expect(signal.aborted).toBe(true);
    stream.push({ type: "error", reason: "aborted", error: output("aborted") }); stream.end();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(session.activeController).toBeUndefined();
  });
});

it("executes supplied gated host tools once and resumes with results, while publishing subscriber events", async () => {
  const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "gated result" }] });
  const adapter = new DroidRuntimeAdapter();
  const { session } = await adapter.createSession({ cwd: "/workspace", systemPrompt: "sys", customTools: [{ name: "fn_verify", parameters: { type: "object" }, execute }] });
  expect(session.model).toBe("glm-5.3-flash");
  const observed: any[] = [];
  const unsubscribe = session.subscribe(event => observed.push(event));
  session.subscribe(() => { throw new Error("observer failed"); });
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const first = new AssistantMessageEventStream();
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const second = new AssistantMessageEventStream();
  vi.mocked(streamViaSdk).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const pending = adapter.promptWithFallback(session, "verify");
  const call = { type: "toolCall", id: "host-call", name: "fn_verify", arguments: { test: true } };
  first.push({ type: "done", reason: "toolUse", message: { ...output("toolUse"), content: [call] } }); first.end();
  second.push({ type: "text_delta", contentIndex: 0, delta: "verified", partial: output() });
  second.push({ type: "done", reason: "stop", message: output() }); second.end();
  await pending;
  expect(execute).toHaveBeenCalledExactlyOnceWith("host-call", { test: true }, expect.any(AbortSignal));
  expect(session.messages).toHaveLength(4);
  expect(session.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "host-call", content: [{ type: "text", text: "gated result" }], isError: false });
  expect(observed).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "tool_execution_start", toolName: "fn_verify" }),
    expect.objectContaining({ type: "tool_execution_end", isError: false }),
    expect.objectContaining({ type: "message_update", assistantMessageEvent: expect.objectContaining({ type: "text_delta" }) }),
  ]));
  unsubscribe();
});

it("keeps denied tools as error results instead of bypassing the gate", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("Action denied"));
  const adapter = new DroidRuntimeAdapter();
  const { session } = await adapter.createSession({ cwd: "/workspace", systemPrompt: "sys", customTools: [{ name: "write", execute }] });
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const first = new AssistantMessageEventStream();
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const second = new AssistantMessageEventStream();
  vi.mocked(streamViaSdk).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const pending = adapter.promptWithFallback(session, "write");
  first.push({ type: "done", reason: "toolUse", message: { ...output("toolUse"), content: [{ type: "toolCall", id: "denied", name: "write", arguments: {} }] } }); first.end();
  second.push({ type: "done", reason: "stop", message: output() }); second.end();
  await pending;
  expect(session.messages[2]).toMatchObject({ isError: true, content: [{ type: "text", text: "Action denied" }] });
});

it("never executes a handed-off tool after cancellation and rejects missing terminal output", async () => {
  const execute = vi.fn();
  const adapter = new DroidRuntimeAdapter();
  const { session } = await adapter.createSession({ cwd: "/workspace", systemPrompt: "sys", customTools: [{ name: "write", execute }] });
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const stream = new AssistantMessageEventStream();
  vi.mocked(streamViaSdk).mockReturnValueOnce(stream);
  const pending = adapter.promptWithFallback(session, "work");
  session.dispose();
  stream.push({ type: "done", reason: "toolUse", message: { ...output("toolUse"), content: [{ type: "toolCall", id: "cancelled", name: "write", arguments: {} }] } }); stream.end();
  await expect(pending).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const empty = new AssistantMessageEventStream(); empty.end();
  vi.mocked(streamViaSdk).mockReturnValueOnce(empty);
  await expect(adapter.promptWithFallback(session, "again")).rejects.toThrow("terminal result");
});

it("propagates provider failures without treating them as completed work", async () => {
  const adapter = new DroidRuntimeAdapter();
  const { session } = await adapter.createSession({ cwd: "/workspace", systemPrompt: "sys" });
  // @ts-expect-error pi-ai runtime constructor is hidden by export-star declarations.
  const stream = new AssistantMessageEventStream();
  vi.mocked(streamViaSdk).mockReturnValueOnce(stream);
  const pending = adapter.promptWithFallback(session, "work");
  stream.push({ type: "error", reason: "error", error: output("error") }); stream.end();
  await expect(pending).rejects.toThrow("failure");
  expect(session.messages).toHaveLength(1);
  expect(session.activeController).toBeUndefined();
});
