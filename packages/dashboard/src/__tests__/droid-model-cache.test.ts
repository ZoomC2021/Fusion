import { afterEach, describe, expect, it, vi } from "vitest";
import type { DroidModelDiscoveryResult } from "../runtime-provider-probes.js";

vi.mock("../runtime-provider-probes.js", () => ({
  discoverDroidCliModels: vi.fn(),
}));

import { discoverDroidCliModels } from "../runtime-provider-probes.js";
import {
  __resetDroidPickerModelsCacheForTests,
  droidDiscoveryToModels,
  getDroidPickerModels,
} from "../droid-model-cache.js";

const mockedDiscover = vi.mocked(discoverDroidCliModels);

afterEach(() => {
  vi.clearAllMocks();
  __resetDroidPickerModelsCacheForTests();
});

describe("droidDiscoveryToModels", () => {
  it("maps a discovered model with a label", () => {
    const models = droidDiscoveryToModels([{ id: "claude-opus-5", label: "Opus 5" }]);
    expect(models).toEqual([
      { provider: "droid-cli", id: "claude-opus-5", name: "Opus 5", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("falls back to the id as the name when no label is provided", () => {
    const models = droidDiscoveryToModels([{ id: "gpt-5.5" }]);
    expect(models).toEqual([
      { provider: "droid-cli", id: "gpt-5.5", name: "gpt-5.5", reasoning: false, contextWindow: 0 },
    ]);
  });

  it("de-duplicates entries that map to the same stable id, keeping the first occurrence", () => {
    const models = droidDiscoveryToModels([
      { id: "claude-opus-5", label: "First" },
      { id: "claude-opus-5", label: "Second" },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("First");
  });

  it("returns an empty array for an empty model list", () => {
    expect(droidDiscoveryToModels([])).toEqual([]);
  });
});

describe("getDroidPickerModels caching", () => {
  it("fetches once and returns mapped models", async () => {
    mockedDiscover.mockResolvedValue({
      models: [{ id: "claude-opus-5", label: "Opus 5" }],
      source: "help-text",
      fallbackUsed: false,
    });

    const models = await getDroidPickerModels({ binaryPath: "droid-test-1" });

    expect(models).toEqual([
      { provider: "droid-cli", id: "claude-opus-5", name: "Opus 5", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("serves subsequent requests within the TTL window from cache with no additional spawn", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "gpt-5.5" }], source: "help-text", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getDroidPickerModels({ binaryPath: "droid-test-2", ttlMs: 60_000, now });
    clock += 30_000;
    await getDroidPickerModels({ binaryPath: "droid-test-2", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL window expires", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "gpt-5.5" }], source: "help-text", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getDroidPickerModels({ binaryPath: "droid-test-3", ttlMs: 1_000, now });
    clock += 1_001;
    await getDroidPickerModels({ binaryPath: "droid-test-3", ttlMs: 1_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent requests for the same binaryPath", async () => {
    let resolveFetch: (v: DroidModelDiscoveryResult) => void = () => {};
    mockedDiscover.mockImplementation(
      () =>
        new Promise<DroidModelDiscoveryResult>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = getDroidPickerModels({ binaryPath: "droid-test-4" });
    const p2 = getDroidPickerModels({ binaryPath: "droid-test-4" });

    resolveFetch({ models: [{ id: "gpt-5.5" }], source: "help-text", fallbackUsed: false });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array (never throws) when the CLI fetch rejects, and caches the empty result", async () => {
    mockedDiscover.mockRejectedValue(new Error("droid exec --help failed: binary not found"));
    let clock = 1000;
    const now = () => clock;

    const first = await getDroidPickerModels({ binaryPath: "droid-test-5", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    clock += 10;
    const second = await getDroidPickerModels({ binaryPath: "droid-test-5", ttlMs: 60_000, now });
    expect(second).toEqual([]);

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });

  it("degrades to an empty array when discovery reports the binary unavailable (fallbackUsed, empty models)", async () => {
    mockedDiscover.mockResolvedValue({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "binary unavailable",
    });

    const models = await getDroidPickerModels({ binaryPath: "droid-test-6" });
    expect(models).toEqual([]);
  });

  it("defaults binaryPath to droid when not explicitly provided", async () => {
    mockedDiscover.mockResolvedValue({ models: [], source: "probe", fallbackUsed: true });

    await getDroidPickerModels();
    expect(mockedDiscover).toHaveBeenCalledWith({ binaryPath: "droid" });
  });

  it("caches distinct binaryPaths independently", async () => {
    mockedDiscover.mockResolvedValue({ models: [{ id: "gpt-5.5" }], source: "help-text", fallbackUsed: false });

    await getDroidPickerModels({ binaryPath: "droid-test-7a" });
    await getDroidPickerModels({ binaryPath: "droid-test-7b" });

    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  // FN-7710: mirrors the Cursor/Grok picker cache negative-TTL hardening — a transient
  // cold-start empty/unavailable result must not poison the cache for the full 60s TTL.
  it("re-fetches an empty/unavailable result well before the full 60s TTL elapses", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [], source: "probe", fallbackUsed: true, reason: "binary unavailable" });
    let clock = 1000;
    const now = () => clock;

    const first = await getDroidPickerModels({ binaryPath: "droid-test-8", ttlMs: 60_000, now });
    expect(first).toEqual([]);

    // Well past a short negative-TTL window, but far short of the full 60s TTL.
    clock += 10_000;
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "gpt-5.5" }], source: "help-text", fallbackUsed: false });
    const second = await getDroidPickerModels({ binaryPath: "droid-test-8", ttlMs: 60_000, now });

    expect(second).toEqual([
      { provider: "droid-cli", id: "gpt-5.5", name: "gpt-5.5", reasoning: false, contextWindow: 0 },
    ]);
    expect(mockedDiscover).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful non-empty result cached for the full requested TTL (unlike an empty result)", async () => {
    mockedDiscover.mockResolvedValueOnce({ models: [{ id: "gpt-5.5" }], source: "help-text", fallbackUsed: false });
    let clock = 1000;
    const now = () => clock;

    await getDroidPickerModels({ binaryPath: "droid-test-9", ttlMs: 60_000, now });
    clock += 10_000; // inside the 60s TTL for a non-empty result
    await getDroidPickerModels({ binaryPath: "droid-test-9", ttlMs: 60_000, now });

    expect(mockedDiscover).toHaveBeenCalledTimes(1);
  });
});
