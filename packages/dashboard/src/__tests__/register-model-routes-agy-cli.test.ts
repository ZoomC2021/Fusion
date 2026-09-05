import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    // FNXC:AgyCli 2026-09-06-00:00: this fixture intentionally omits an
    // "agy-cli" key so the toggle path (agyCliEnabled -> configuredProviders.add)
    // is proven on its own, not masked by an auth.json entry. Mirrors the
    // cursor-cli test fixture (FN-7696).
    readFile: vi.fn().mockResolvedValue('{"anthropic":{},"openai":{}}'),
  };
});

vi.mock("../agy-model-cache.js", () => ({
  getAgyPickerModels: vi.fn(),
  AGY_PICKER_PROVIDER_ID: "agy-cli",
}));

import type { Router } from "express";
import { getAgyPickerModels } from "../agy-model-cache.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const mockedGetAgyPickerModels = vi.mocked(getAgyPickerModels);

function setup(
  agyCliEnabled?: boolean,
  registryModels?: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }>,
  agyCliBinaryPath?: unknown,
) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    post: vi.fn(),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ agyCliEnabled, agyCliBinaryPath }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue({}),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(
      () =>
        registryModels ?? [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 }],
    ),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return getHandlers.get("/models")!;
}

async function invoke(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string }> };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registerModelRoutes agy-cli merge and filter", () => {
  it("filters agy-cli models when agyCliEnabled is false, even when discovery would return some", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(false);
    const response = await invoke(handler);
    expect(response.models.some((model) => model.provider === "agy-cli")).toBe(false);
    // Discovery must not even be attempted when the toggle is off.
    expect(mockedGetAgyPickerModels).not.toHaveBeenCalled();
  });

  it("includes discovered agy-cli models when agyCliEnabled is true, via the toggle alone (no auth.json entry needed)", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: false, contextWindow: 0 },
      { provider: "agy-cli", id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    const agyRows = response.models.filter((m) => m.provider === "agy-cli");
    expect(agyRows.map((m) => m.id).sort()).toEqual(["gemini-3-pro", "gemini-3.7-flash-high"]);
  });

  it("preserves all pre-existing rows (openai, anthropic-style) alongside newly-surfaced agy-cli rows", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "droid-cli", id: "droid-1", name: "Droid 1", reasoning: false, contextWindow: 0 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
    expect(response.models.some((m) => m.provider === "agy-cli" && m.id === "gemini-3.7-flash-high")).toBe(true);
  });

  it("dedupes by provider/id when a discovered id collides with an existing registry row — existing row wins", async () => {
    const registryModels = [
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Registry Gemini (pre-existing)", reasoning: true, contextWindow: 1000000 },
    ];
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Discovered Gemini (should be dropped)", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const agyRows = response.models.filter((m) => m.provider === "agy-cli" && m.id === "gemini-3.7-flash-high");
    expect(agyRows).toHaveLength(1);
    expect(agyRows[0]?.name).toBe("Registry Gemini (pre-existing)");
  });

  it("degrades to zero agy-cli rows (HTTP 200, existing rows intact) when discovery returns empty", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "agy-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("degrades to zero agy-cli rows (never rejects the handler) when discovery throws", async () => {
    mockedGetAgyPickerModels.mockRejectedValue(new Error("agy unavailable"));
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "agy-cli")).toBe(false);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("surfaces a single discovered model", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-3-only", name: "Only", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true);
    const response = await invoke(handler);
    expect(response.models.filter((m) => m.provider === "agy-cli")).toHaveLength(1);
  });

  it("final response is deduped by provider/id across all merged sources", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-dup", name: "A", reasoning: false, contextWindow: 0 },
    ]);
    const registryModels = [
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
      { provider: "openai", id: "gpt-5", name: "GPT-5 dup", reasoning: true, contextWindow: 128000 },
    ];
    const handler = setup(true, registryModels);
    const response = await invoke(handler);
    const keys = response.models.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/*
FNXC:AgyCli 2026-09-06-00:00:
the machine-local agyCliBinaryPath operator override (already honored by the
auth/probe/status paths in register-auth-routes.ts) must also apply to
model-picker discovery, so an operator whose agy is not on PATH still sees agy
models in the picker. These tests assert the normalized override is threaded
into getAgyPickerModels({ binaryPath }) verbatim, that blank/undefined
preserves binaryPath: undefined (PATH auto-detection), and that the toggle-off
gate is not regressed. Mirrors the cursorCliBinaryPath threading tests
(FN-7699).
*/
describe("registerModelRoutes agyCliBinaryPath threading", () => {
  it("threads a set agyCliBinaryPath override into getAgyPickerModels verbatim", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: false, contextWindow: 0 },
    ]);
    const handler = setup(true, undefined, "/opt/agy/bin/agy");
    const response = await invoke(handler);
    expect(mockedGetAgyPickerModels).toHaveBeenCalledWith({ binaryPath: "/opt/agy/bin/agy" });
    expect(response.models.some((m) => m.provider === "agy-cli" && m.id === "gemini-3.7-flash-high")).toBe(true);
  });

  it("threads a Windows-shim-style override path verbatim, with no mangling", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([]);
    const winPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\agy.cmd";
    const handler = setup(true, undefined, winPath);
    await invoke(handler);
    expect(mockedGetAgyPickerModels).toHaveBeenCalledWith({ binaryPath: winPath });
  });

  it("passes binaryPath: undefined when agyCliBinaryPath is absent (PATH auto-detection preserved)", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, undefined);
    await invoke(handler);
    expect(mockedGetAgyPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when agyCliBinaryPath is blank/whitespace-only", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, "   ");
    await invoke(handler);
    expect(mockedGetAgyPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when agyCliBinaryPath is an empty string", async () => {
    mockedGetAgyPickerModels.mockResolvedValue([]);
    const handler = setup(true, undefined, "");
    await invoke(handler);
    expect(mockedGetAgyPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("does not surface agy-cli rows or call getAgyPickerModels when agyCliEnabled is false, regardless of agyCliBinaryPath", async () => {
    const handler = setup(false, undefined, "/opt/agy/bin/agy");
    const response = await invoke(handler);
    expect(mockedGetAgyPickerModels).not.toHaveBeenCalled();
    expect(response.models.some((m) => m.provider === "agy-cli")).toBe(false);
  });
});
