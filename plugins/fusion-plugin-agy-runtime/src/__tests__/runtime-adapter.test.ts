import { describe, expect, it, vi } from "vitest";
import { AgyRuntimeAdapter } from "../runtime-adapter.js";
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

  it("records bridge-start-failed when fusionTools are requested (slice 2 seam)", async () => {
    const adapter = new AgyRuntimeAdapter();
    const { session } = await adapter.createSession({
      cwd: "/tmp",
      systemPrompt: "system",
      fusionTools: [{ name: "fn_task_list", execute: vi.fn() }],
    });
    expect(session.fusionToolBridgeError).toEqual({ reasonCode: "bridge-start-failed" });
    expect(session.toolBridge).toBeUndefined();
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
