import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { spawn, spawnSync } from "node:child_process";
import { assertCmdBoundarySafe, quoteCmdArgument, resolvePowerShellExecutable, runAgyCommand } from "../cli-spawn.js";

function mockPlatform(platform: NodeJS.Platform) {
  return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

describe("runAgyCommand", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the Windows shell so PATH .cmd and .bat agy shims can run", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("agy", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    child.stdout.write("1.1.27\n");
    child.stderr.write("diagnostic\n");
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stdout: "1.1.27\n",
      stderr: "diagnostic\n",
    });
  });

  it("keeps non-Windows agy invocations on direct spawn", async () => {
    mockPlatform("darwin");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["--version"], 1000);

    expect(spawn).toHaveBeenCalledWith("agy", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it("returns spawn errors with diagnostics instead of empty stderr", async () => {
    mockPlatform("win32");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["--version"], 1000);
    child.emit("error", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));

    const result = await resultPromise;
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("spawn error: ENOENT: spawn agy ENOENT");
  });

  it("kills timed-out agy commands best-effort and resolves once", async () => {
    vi.useFakeTimers();
    mockPlatform("linux");
    const child = createMockChild();

    const resultPromise = runAgyCommand("agy", ["models"], 25);
    child.stdout.write("partial");

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({ code: 124, stdout: "partial", stderr: "" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 124 });
  });
});

describe("cmd boundary validation", () => {
  it("falls back to Windows PowerShell when pwsh is not resolvable", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as never);
    expect(resolvePowerShellExecutable()).toBe("powershell.exe");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "C:\\Program Files\\PowerShell\\7\\pwsh.exe\n" } as never);
    expect(resolvePowerShellExecutable()).toBe("pwsh.exe");
  });

  it("allows agy bracketed parameterized model identifiers", () => {
    const model = "gemini-3.7-flash-low[context=1m]";
    expect(() => assertCmdBoundarySafe(model)).not.toThrow();
    expect(quoteCmdArgument(model)).toBe(`"${model}"`);
  });

  it("rejects cmd control characters rather than escaping them", () => {
    expect(() => assertCmdBoundarySafe("model&payload")).toThrow(/&/);
  });
});
