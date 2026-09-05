import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runAgyCommand: vi.fn() }));

import { runAgyCommand } from "../cli-spawn.js";
import { probeAgyBinary } from "../probe.js";

const MODELS_OUTPUT = [
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
].join("\n");

describe("probeAgyBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports authenticated:true when agy models yields models", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.1.27\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: MODELS_OUTPUT, stderr: "Fetching available models...\n" });

    const result = await probeAgyBinary({ binaryPath: "/usr/local/bin/agy" });

    expect(runAgyCommand).toHaveBeenNthCalledWith(1, "/usr/local/bin/agy", ["--version"], 8_000);
    expect(runAgyCommand).toHaveBeenNthCalledWith(2, "/usr/local/bin/agy", ["models"], 8_000);
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe("1.1.27");
    expect(result.binaryPath).toBe("/usr/local/bin/agy");
    expect(result.configuredBinaryPath).toBe("/usr/local/bin/agy");
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });

  it("reports authenticated:false with an actionable reason when agy models returns no models", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.1.27\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "Fetching available models...\n" });

    const result = await probeAgyBinary({ binaryPath: "agy" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("not authenticated");
  });

  it("fails closed to authenticated:false when agy models exits non-zero", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.1.27\n", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "backend error" });

    const result = await probeAgyBinary({ binaryPath: "agy" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("not authenticated");
  });

  it("surfaces a keyring/secret-service lock as a distinct auth-failure reason", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.1.27\n", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Error: Secret Service is unavailable" });

    const result = await probeAgyBinary({ binaryPath: "agy" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("keyring/secret-service");
  });

  it("surfaces a keyring lock detected at --version time", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Error: keyring is locked" });

    const result = await probeAgyBinary({ binaryPath: "agy" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("keyring/secret-service");
  });

  it("probes the configured binary before the PATH fallback", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: /missing/agy" })
      .mockResolvedValueOnce({ code: 0, stdout: "1.1.27\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: MODELS_OUTPUT, stderr: "" });

    const result = await probeAgyBinary({ binaryPath: "/missing/agy" });

    expect(runAgyCommand).toHaveBeenNthCalledWith(1, "/missing/agy", ["--version"], 8_000);
    expect(runAgyCommand).toHaveBeenNthCalledWith(2, "agy", ["--version"], 8_000);
    expect(runAgyCommand).toHaveBeenNthCalledWith(3, "agy", ["models"], 8_000);
    expect(result.available).toBe(true);
    expect(result.binaryPath).toBe("agy");
    expect(result.usingConfiguredBinaryPath).toBe(false);
    expect(result.diagnostics?.[0]).toContain("/missing/agy: spawn error: ENOENT");
  });

  it("reports binary unavailable with actionable diagnostics when all candidates fail", async () => {
    vi.mocked(runAgyCommand).mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: agy" });

    const result = await probeAgyBinary();

    expect(result.available).toBe(false);
    expect(result.reason).toContain("not found");
    expect(result.reason).toContain("agy: spawn error: ENOENT");
  });

  it("dedupes an override equal to the default PATH candidate name", async () => {
    vi.mocked(runAgyCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.1.27\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: MODELS_OUTPUT, stderr: "" });

    const result = await probeAgyBinary({ binaryPath: " agy " });

    expect(runAgyCommand).toHaveBeenCalledTimes(2);
    expect(runAgyCommand).toHaveBeenNthCalledWith(1, "agy", ["--version"], 8_000);
    expect(result.binaryPath).toBe("agy");
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });
});
