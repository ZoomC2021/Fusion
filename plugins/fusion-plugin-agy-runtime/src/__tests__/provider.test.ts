import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../probe.js", () => ({ probeAgyBinary: vi.fn() }));
vi.mock("../process-manager.js", () => ({ discoverAgyModels: vi.fn() }));

import { discoverAgyModels } from "../process-manager.js";
import { probeAgyBinary } from "../probe.js";
import { discoverAgyProviderModels } from "../provider.js";

describe("discoverAgyProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the override-aware probe binary for model discovery and carries labels", async () => {
    vi.mocked(probeAgyBinary).mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "C:\\Users\\A User\\AppData\\Local\\agy\\bin\\agy.exe",
      binaryPath: "C:\\Users\\A User\\AppData\\Local\\agy\\bin\\agy.exe",
      configuredBinaryPath: "C:\\Users\\A User\\AppData\\Local\\agy\\bin\\agy.exe",
      usingConfiguredBinaryPath: true,
      probeDurationMs: 12,
    });
    vi.mocked(discoverAgyModels).mockResolvedValue({
      models: [{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" }],
      source: "models-text",
      fallbackUsed: false,
    });

    const result = await discoverAgyProviderModels({ binaryPath: "C:\\Users\\A User\\AppData\\Local\\agy\\bin\\agy.exe" });

    expect(probeAgyBinary).toHaveBeenCalledWith({ binaryPath: "C:\\Users\\A User\\AppData\\Local\\agy\\bin\\agy.exe" });
    expect(discoverAgyModels).toHaveBeenCalledWith("C:\\Users\\A User\\AppData\\Local\\agy\\bin\\agy.exe");
    expect(result.models).toEqual([{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" }]);
    expect(result.source).toBe("models-text");
  });

  it("returns probe diagnostics when no effective binary is available", async () => {
    vi.mocked(probeAgyBinary).mockResolvedValue({
      available: false,
      authenticated: false,
      configuredBinaryPath: "/missing/agy",
      reason: "Configured agy CLI binary '/missing/agy' failed; PATH fallback agy also failed",
      probeDurationMs: 10,
    });

    const result = await discoverAgyProviderModels({ binaryPath: "/missing/agy" });

    expect(discoverAgyModels).not.toHaveBeenCalled();
    expect(result).toEqual({
      models: [],
      source: "probe",
      fallbackUsed: true,
      reason: "Configured agy CLI binary '/missing/agy' failed; PATH fallback agy also failed",
    });
  });
});
