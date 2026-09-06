import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";

const model: Model<"openai-responses"> = {
  id: "terminal-fixture", name: "Terminal fixture", provider: "fixture", api: "openai-responses",
  baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"],
  contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tool = { id: "fc_1", type: "function_call", call_id: "call_1", name: "probe", arguments: "{}", status: "completed" };
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const trailer = { type: "error", code: "proxy_trailer", message: "late intermediary failure" };
function run(events: object[]) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  return streamSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, {
    apiKey: "fixture", fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  }).result();
}

describe("Responses terminal events", () => {
  it("preserves completed host calls and usage despite a trailing proxy error", async () => {
    const result = await run([
      { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item: tool },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [tool], usage } },
      trailer,
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual({ type: "toolCall", id: "call_1|fc_1", name: "probe", arguments: {} });
    expect(result.usage.totalTokens).toBe(12);
    expect(result.errorMessage).toBeUndefined();
  });

  it("preserves a completed text reply despite a trailing proxy error", async () => {
    const item = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "ready", annotations: [] }] };
    const result = await run([
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ready" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item], usage } }, trailer,
    ]);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ready" })]);
  });

  it("preserves a token-limit terminal outcome", async () => {
    const result = await run([{ type: "response.incomplete", response: { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" }, usage } }, trailer]);
    expect(result.stopReason).toBe("length");
  });

  it.each([
    ["failed response", [{ type: "response.failed", response: { status: "failed", error: { code: "rejected", message: "rejected" } } }]],
    ["early error", [trailer]],
    ["missing terminal event", [{ type: "response.created", response: { status: "in_progress" } }]],
  ])("still rejects %s", async (_name, events) => {
    const result = await run(events as object[]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();
  });
});
