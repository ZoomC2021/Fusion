import { describe, expect, it } from "vitest";
import { buildSdkPrompt } from "../sdk-prompt.js";

const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
describe("Droid SDK image attachments", () => {
  it("preserves user and tool-result history in ordered attachments without mutating the transcript", () => {
    const context = { messages: [
      { role: "user", content: [{ type: "text", text: "first" }, image] },
      { role: "assistant", content: [{ type: "toolCall", name: "read", id: "call-1", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", content: [image, { type: "text", text: "screenshot" }] },
      { role: "user", content: [image, { type: "text", text: "compare all three" }] },
    ] };
    const original = JSON.stringify(context);
    const { prompt, images } = buildSdkPrompt(context);
    expect(images).toEqual(Array.from({ length: 3 }, () => ({ type: "base64", data: image.data, mediaType: image.mimeType })));
    for (const index of [1, 2, 3]) expect(prompt).toContain(`Image attachment ${index}; image/png`);
    expect(prompt).toContain('"toolCallId":"call-1"');
    expect(prompt).toContain("compare all three");
    expect(prompt).not.toContain(image.data);
    expect(JSON.stringify(context)).toBe(original);
  });
  it.each(["image/jpeg", "image/png", "image/gif", "image/webp"])("forwards supported media %s", (mimeType) => {
    expect(buildSdkPrompt({ messages: [{ role: "user", content: [{ ...image, mimeType }] }] }).images[0].mediaType).toBe(mimeType);
  });
  it.each([
    { ...image, data: "" }, { ...image, data: "%%%" }, { ...image, data: undefined },
    { ...image, data: "file:///private/image.png" }, { ...image, data: "https://example.com/image.png" },
    { ...image, mimeType: "image/svg+xml" }, { ...image, mimeType: undefined },
  ])("rejects malformed or external image sources without echoing them", (input) => {
    expect(() => buildSdkPrompt({ messages: [{ role: "toolResult", content: [input] }] })).toThrow(/Droid image/);
  });
  it("leaves text-only conversation data intact", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = buildSdkPrompt({ messages });
    expect(result.images).toEqual([]);
    expect(result.prompt).toContain(JSON.stringify(messages));
  });
});

it.each([0, 1, 2])("accepts multi-megabyte base64 with %s padding bytes without overflowing the stack", (padding) => {
  const data = "A".repeat(8_000_000 - padding) + "=".repeat(padding);
  const { prompt, images } = buildSdkPrompt({ messages: [{ role: "user", content: [{ ...image, data }] }] });
  expect(images[0].data).toBe(data);
  expect(prompt.length).toBeLessThan(500);
});

it.each(["=AAA", "A=AA", "AA=A", "A===", "AAAA=", "AAA", "AA-A", "AA_A", "AAA\n"])("rejects invalid base64 alphabet, padding or length: %j", (data) => {
  expect(() => buildSdkPrompt({ messages: [{ role: "user", content: [{ ...image, data }] }] })).toThrow("invalid base64");
});
