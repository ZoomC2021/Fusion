import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runAgyCommand: vi.fn() }));

import { runAgyCommand } from "../cli-spawn.js";
import { discoverAgyModels } from "../process-manager.js";

const REAL_MODELS_OUTPUT = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

describe("discoverAgyModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes only `models` and parses tab-separated id/label rows", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: REAL_MODELS_OUTPUT, stderr: "Fetching available models...\n" });
    const result = await discoverAgyModels("agy");

    expect(runAgyCommand).toHaveBeenCalledTimes(1);
    expect(runAgyCommand).toHaveBeenCalledWith("agy", ["models"], 10_000);
    expect(result.models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
    expect(result.source).toBe("models-text");
    expect(result.fallbackUsed).toBe(false);
  });

  it("ignores the stderr fetching notice and a defensive stdout header line", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({
      code: 0,
      stdout: "Fetching available models...\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
      stderr: "",
    });
    const result = await discoverAgyModels("agy");

    expect(result.models).toEqual([{ id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" }]);
  });

  it("dedupes repeated ids", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({
      code: 0,
      stdout: "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
      stderr: "",
    });
    const result = await discoverAgyModels("agy");

    expect(result.models).toEqual([
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
  });

  it("falls back to the id as label when no tab is present", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "bare-model-id", stderr: "" });
    const result = await discoverAgyModels("agy");

    expect(result.models).toEqual([{ id: "bare-model-id", label: "bare-model-id" }]);
  });

  it("returns an empty list with a clear reason when stdout is empty", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "", stderr: "Fetching available models...\n" });
    const result = await discoverAgyModels("agy");

    expect(result).toEqual({ models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no output" });
  });

  it("returns an empty list when only blank/header lines are present", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "Fetching available models...\n\n", stderr: "" });
    const result = await discoverAgyModels("agy");

    expect(result.models).toEqual([]);
    expect(result.fallbackUsed).toBe(true);
  });

  it("returns empty discovery when the command fails outright", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT" });

    const result = await discoverAgyModels("agy", 2500);

    expect(runAgyCommand).toHaveBeenCalledWith("agy", ["models"], 2500);
    expect(result).toEqual({ models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" });
  });

  it("passes a Windows path with spaces as one binary string", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 0, stdout: "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)", stderr: "" });
    const binary = "C:\\Program Files\\agy\\agy.exe";

    const result = await discoverAgyModels(binary);

    expect(runAgyCommand).toHaveBeenCalledWith(binary, ["models"], 10_000);
    expect(result.models).toEqual([{ id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" }]);
  });
});
