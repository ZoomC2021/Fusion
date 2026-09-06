import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgyModelDiscoveryResult } from "../runtime-provider-probes.js";

vi.mock("../runtime-provider-probes.js", () => ({
  discoverAgyCliModels: vi.fn(),
}));

import { discoverAgyCliModels } from "../runtime-provider-probes.js";
import {
  __resetAgyPickerModelsCacheForTests,
  agyDiscoveryToModels,
  getAgyPickerModels,
} from "../agy-model-cache.js";

const mockedDiscover = vi.mocked(discoverAgyCliModels);

afterEach(() => {
  vi.clearAllMocks();
  __resetAgyPickerModelsCacheForTests();
});

describe("agyDiscoveryToModels", () => {
  it("maps a discovered model with a label", () => {
    const models = agyDiscoveryToModels([{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" }]);
    expect(models).toEqual([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("falls back to the id as the name when no label is provided", () => {
    const models = agyDiscoveryToModels([{ id: "gemini-3.7-flash-high" }]);
    expect(models).toEqual([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "gemini-3.7-flash-high", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("maps multiple models preserving order", () => {
    const models = agyDiscoveryToModels([{ id: "gemini-3.7-flash-high" }, { id: "gemini-3-pro" }]);
    expect(models.map((m) => m.id)).toEqual(["gemini-3.7-flash-high", "gemini-3-pro"]);
  });

  it("de-duplicates entries that map to the same stable id, keeping the first occurrence", () => {
    const models = agyDiscoveryToModels([
      { id: "gemini-3.7-flash-high", label: "First" },
      { id: "gemini-3.7-flash-high", label: "Second" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("First");
  });

  it("returns an empty array for an empty model list", () => {
    expect(agyDiscoveryToModels([])).toEqual([]);
  });

  it("surfaces source-reported reasoning/contextWindow metadata when present", () => {
    const models = agyDiscoveryToModels([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", reasoning: true, contextWindow: 1000000 },
    ]);
    expect(models).toEqual([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: true, contextWindow: 1000000 },
    ]);
  });

  it("defaults reasoning/contextWindow to false/0 when the entry does not report them", () => {
    const models = agyDiscoveryToModels([{ id: "gemini-3-pro" }]);
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.contextWindow).toBe(0);
  });

  it("handles a mix of enriched and default entries independently", () => {
    const models = agyDiscoveryToModels([
      { id: "gemini-a", reasoning: true, contextWindow: 128000 },
      { id: "gemini-b" },
    ]);
    expect(models).toEqual([
      { provider: "agy-cli", id: "gemini-a", name: "gemini-a", reasoning: true, contextWindow: 128000 },
      { provider: "agy-cli", id: "gemini-b", name: "gemini-b", reasoning: false, contextWindow: 0 },
    ]);
  });
});

describe("getAgyPickerModels caching", () => {
  it("fetches once and returns mapped models", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" }],
      source: "agy models",
      fallbackUsed: false,
    });

    const models = await getAgyPickerModels({ binaryPath: "agy-test-1" });

    expect(models).toEqual([
      { provider: "agy-cli", id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("serves subsequent requests within the TTL window from cache with no additional spawn", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "gemini-3-pro" }], source: "agy models", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getAgyPickerModels({ binaryPath: "agy-test-2", ttlMs: 60_000, now });
    clock += 30_000; // still inside the 60s TTL
    await getAgyPickerModels({ binaryPath: "agy-test-2", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL window expires", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "gemini-3-pro" }], source: "agy models", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getAgyPickerModels({ binaryPath: "agy-test-3", ttlMs: 1_000, now });
    clock += 1_001; // past the 1s TTL
    await getAgyPickerModels({ binaryPath: "agy-test-3", ttlMs: 1_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for the same binaryPath", async () => {
    let resolveFetch: (v: AgyModelDiscoveryResult) => void = () => {};
    mockedDiscover.mockImplementation(
      () =>
        new Promise<AgyModelDiscoveryResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = getAgyPickerModels({ binaryPath: "agy-test-4" });
    const p2 = getAgyPickerModels({ binaryPath: "agy-test-4" });

    resolveFetch({ models: [{ id: "gemini-3-pro" }], source: "agy models", fallbackUsed: false });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array (never throws) when the CLI fetch rejects, and caches the empty result", async () => {
    mockedDiscover.mockRejectedValue(new Error("agy models failed: binary not found"));
    let clock = 1000;
    const now = () => clock;

    const first = await getAgyPickerModels({ binaryPath: "agy-test-5", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    clock += 10; // still inside TTL
    const second = await getAgyPickerModels({ binaryPath: "agy-test-5", ttlMs: 60_000, now });
    expect(second).toEqual([]);

    // The failure result is cached too — only one spawn attempt within the TTL window.
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array when discovery reports the binary unavailable (fallbackUsed, empty models)", async () => {
    mockedDiscover.mockResolvedValue({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "binary unavailable",
    });

    const models = await getAgyPickerModels({ binaryPath: "agy-test-6" });
    expect(models).toEqual([]);
  });

  it("defaults binaryPath to agy when not explicitly provided", async () => {
    mockedDiscover.mockResolvedValue({ models: [], source: "probe", fallbackUsed: true });

    await getAgyPickerModels();
    expect(mockedDiscover).toHaveBeenCalledWith({ binaryPath: "agy" });
  });

  it("caches distinct binaryPaths independently", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "gemini-3-pro" }], source: "agy models", fallbackUsed: false });

    await getAgyPickerModels({ binaryPath: "agy-test-7a" });
    await getAgyPickerModels({ binaryPath: "agy-test-7b" });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  // A transient cold-start empty/unavailable result must not poison the cache
  // for the full 60s TTL — it self-heals after a much shorter negative-TTL
  // window while a non-empty result keeps the normal TTL.
  it("re-fetches an empty/unavailable result well before the full 60s TTL elapses", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [], source: "probe", fallbackUsed: true, reason: "binary unavailable" });
    let clock = 1000;
    const now = () => clock;

    const first = await getAgyPickerModels({ binaryPath: "agy-test-8", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    // Well past a short negative-TTL window, but far short of the full 60s TTL.
    clock += 10_000;
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "gemini-3-pro" }], source: "agy models", fallbackUsed: false });
    const second = await getAgyPickerModels({ binaryPath: "agy-test-8", ttlMs: 60_000, now });

    expect(second).toEqual([
      { provider: "agy-cli", id: "gemini-3-pro", name: "gemini-3-pro", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful non-empty result cached for the full requested TTL (unlike an empty result)", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "gemini-3-pro" }], source: "agy models", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getAgyPickerModels({ binaryPath: "agy-test-9", ttlMs: 60_000, now });
    clock += 10_000; // inside the 60s TTL for a non-empty result
    await getAgyPickerModels({ binaryPath: "agy-test-9", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });
});
