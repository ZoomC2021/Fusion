import { describe, expect, it, vi } from "vitest";
import { AgyRuntimeAdapter } from "../runtime-adapter.js";
import * as scoped from "../scoped-mcp.js";
import * as transport from "../prompt-transport.js";

describe("AgyRuntimeAdapter", () => {
  it("normalizes model, defaults mode to plan, and creates a cwd-bound session", async () => {
    const result = await new AgyRuntimeAdapter().createSession({ cwd: "/tmp", systemPrompt: "sys", defaultModelId: "agy-cli/gemini-3.7-flash-high", tools: "readonly" });
    expect(result.session.model).toBe("gemini-3.7-flash-high");
    expect(result.session.mode).toBe("plan");
    expect(result.session.cwd).toBe("/tmp");
    expect(result.session.tools).toBe("readonly");
    expect(new AgyRuntimeAdapter().describeModel(result.session)).toBe("agy-cli/gemini-3.7-flash-high");
  });

  it("defaults the model to gemini-3.7-flash-high and mode to plan when none given", async () => {
    const { session } = await new AgyRuntimeAdapter().createSession({ cwd: "/tmp", systemPrompt: "sys" });
    expect(session.model).toBe("gemini-3.7-flash-high");
    expect(session.mode).toBe("plan");
    expect(new AgyRuntimeAdapter().describeModel(session)).toBe("agy-cli/gemini-3.7-flash-high");
  });

  it("sets mode to accept-edits for coding", async () => {
    const { session } = await new AgyRuntimeAdapter().createSession({ cwd: "/tmp", systemPrompt: "sys", tools: "coding" });
    expect(session.mode).toBe("accept-edits");
  });

  it("fuses the system prompt into the first turn only and resumes retained conversationId", async () => {
    const spy = vi.spyOn(transport, "launchAgyPrompt").mockResolvedValueOnce({ conversationId: "c1", text: "first" }).mockResolvedValueOnce({ conversationId: "c1", text: "second" });
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system", tools: "readonly" });
    await adapter.promptWithFallback(session, "one");
    await adapter.promptWithFallback(session, "two");
    expect(spy.mock.calls[0][0]).toMatchObject({ cwd: "/tmp", tools: "readonly", conversationId: undefined });
    expect(spy.mock.calls[0][0].prompt).toContain("system");
    expect(spy.mock.calls[0][0].prompt).toContain("User request:\none");
    expect(spy.mock.calls[1][0]).toMatchObject({ prompt: "two", conversationId: "c1", tools: "readonly" });
    expect(spy.mock.calls[1][0].prompt).toBe("two");
    expect(session.conversationId).toBe("c1");
    expect(session.messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first" },
      { role: "user", content: "two" },
      { role: "assistant", content: "second" },
    ]);
    spy.mockRestore();
  });

  it("forwards every assistant delta verbatim, including repeated identical deltas", async () => {
    const text = vi.fn();
    vi.spyOn(transport, "launchAgyPrompt").mockImplementationOnce(async (input) => {
      input.onText?.("\n");
      input.onText?.("\n");
      return { conversationId: "c1", text: "\n\n" };
    });
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system", onText: text });
    await adapter.promptWithFallback(session, "x");
    expect(text).toHaveBeenCalledTimes(2);
    expect(text).toHaveBeenNthCalledWith(1, "\n");
    expect(text).toHaveBeenNthCalledWith(2, "\n");
    expect(session.messages).toEqual([
      { role: "user", content: "x" },
      { role: "assistant", content: "\n\n" },
    ]);
    vi.restoreAllMocks();
  });

  it("restores the prior conversationId on transport failure", async () => {
    vi.spyOn(transport, "launchAgyPrompt").mockRejectedValueOnce(new Error("failed"));
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system" });
    session.conversationId = "prior";
    await expect(adapter.promptWithFallback(session, "x")).rejects.toThrow("failed");
    expect(session.conversationId).toBe("prior");
    vi.restoreAllMocks();
  });

  it("rejects when the session is disposed", async () => {
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system" });
    await session.dispose();
    await expect(adapter.promptWithFallback(session, "x")).rejects.toThrow(/disposed/);
  });

  it.each(["fusionTools", "customTools"])("refuses unavailable %s before native work starts", async key => {
    const spy = vi.spyOn(transport, "launchAgyPrompt");
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "sys", [key]: [{ name: "fn_task_done", execute: vi.fn() }] });
    const bridge = vi.spyOn(scoped, "startScopedMcp").mockRejectedValue(new Error("required Fusion/custom tools unavailable"));
    await expect(adapter.promptWithFallback(session, "work")).rejects.toThrow("required Fusion/custom tools");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    bridge.mockRestore();
  });

  it("does not record a bridge error when no fusionTools are requested", async () => {
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system" });
    expect(session.fusionToolBridgeError).toBeUndefined();
  });

  it("disposal aborts an active turn exactly once", async () => {
    vi.spyOn(transport, "launchAgyPrompt").mockImplementationOnce((input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "system" });
    session.conversationId = "prior";
    const active = adapter.promptWithFallback(session, "active");
    await session.dispose();
    await session.dispose();
    await expect(active).rejects.toThrow(/aborted/);
    expect(session.activeAbortController).toBeUndefined();
    expect(session.disposed).toBe(true);
    vi.restoreAllMocks();
  });
});

it("honors caller cancellation and refuses overlapping turns without losing its controller", async () => {
  const spy = vi.spyOn(transport, "launchAgyPrompt").mockImplementationOnce(input => new Promise((_resolve, reject) => {
    input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const adapter = new AgyRuntimeAdapter();
  const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "sys" });
  const controller = new AbortController();
  const active = adapter.promptWithFallback(session, "first", { signal: controller.signal });
  await expect(adapter.promptWithFallback(session, "second")).rejects.toThrow("active turn");
  controller.abort();
  await expect(active).rejects.toThrow("aborted");
  expect(session.messages).toEqual([]);
  expect(session.activeAbortController).toBeUndefined();
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

it("never starts a caller-preaborted turn", async () => {
  const spy = vi.spyOn(transport, "launchAgyPrompt");
  const adapter = new AgyRuntimeAdapter();
  const { session } = await adapter.createSession({ cwd: "/tmp", systemPrompt: "sys" });
  await expect(adapter.promptWithFallback(session, "work", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

it.each(["success", "failure"])("cleans up a scoped bridge after transport %s and retains the server key across turns", async outcome => {
  const dispose = vi.fn().mockResolvedValue(undefined);
  const bridge = vi.spyOn(scoped, "startScopedMcp").mockResolvedValue({configPath: "/private/config", targetPath: "/global/config", dispose});
  const transportSpy = vi.spyOn(transport, "launchAgyPrompt");
  if (outcome === "success") transportSpy.mockResolvedValue({text: "ok", conversationId: "c1"});
  else transportSpy.mockRejectedValue(new Error("failed"));
  const adapter = new AgyRuntimeAdapter();
  const execute = vi.fn();
  const {session} = await adapter.createSession({cwd: "/tmp", systemPrompt: "sys", fusionTools: [{name: "fn_done", execute}], customTools: [{name: "fn_done", execute}, {name: "custom", execute}]});
  const key = session.mcpServerKey;
  for (let i = 0; i < 2; i++) {
    if (outcome === "success") await adapter.promptWithFallback(session, "work");
    else await expect(adapter.promptWithFallback(session, "work")).rejects.toThrow("failed");
  }
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(bridge.mock.calls[0][0].map(tool => tool.name)).toEqual(["fn_done", "custom"]);
  expect(bridge.mock.calls[1][1]).toBe(key);
  expect(transportSpy.mock.calls[0][0].scopedMcp?.configPath).toBe("/private/config");
  vi.restoreAllMocks();
});
