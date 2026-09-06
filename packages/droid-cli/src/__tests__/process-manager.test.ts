import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mock child_process.spawn before importing process-manager
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    proc.pid = 12345;
    return proc;
  }),
}));

const mocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  tmpdir: vi.fn(() => "/mock-tmp"),
}));

vi.mock("node:fs", () => ({
  writeFileSync: mocks.writeFileSync,
  unlinkSync: mocks.unlinkSync,
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

vi.mock("node:os", () => ({
  tmpdir: mocks.tmpdir,
}));

import { spawn } from "node:child_process";
import { validateCliPresenceAsync, discoverDroidModels } from "../process-manager";

describe("validateCliPresenceAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves ok=true when droid --version exits 0", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 0));
      return proc;
    });

    const result = await validateCliPresenceAsync();
    expect(result).toEqual({ ok: true });
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toEqual(["--version"]);
  });

  it("resolves ok=false with install message when spawn errors", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    });

    const result = await validateCliPresenceAsync();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Droid CLI not found");
      expect(result.error.message).toContain("Install Droid CLI");
    }
  });

  it("resolves ok=false when droid --version exits non-zero", async () => {
    const EventEmitter = require("node:events");
    (spawn as any).mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.kill = vi.fn();
      setImmediate(() => proc.emit("exit", 1));
      return proc;
    });

    const result = await validateCliPresenceAsync();
    expect(result.ok).toBe(false);
  });

  it("resolves ok=false instead of rejecting when droid spawn throws synchronously", async () => {
    (spawn as any).mockImplementationOnce(() => {
      throw new Error("Real AI CLI launch blocked during tests: droid --version");
    });

    await expect(validateCliPresenceAsync()).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("discoverDroidModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses model ids from droid exec --help output", async () => {
    (spawn as any).mockImplementationOnce(() => {
      const EventEmitter = require("node:events");
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from(`Usage: droid exec [options] [prompt]

Available Models:
  droid-pro                 Droid Pro
  droid-max                 Droid Max

Model details:
  - Droid Pro: prose, not a model id
`));
        proc.emit("exit", 0);
      }, 0);
      return proc;
    });

    await expect(discoverDroidModels()).resolves.toEqual(["droid-pro", "droid-max"]);
    expect(spawn).toHaveBeenCalledWith("droid", ["exec", "--help"], expect.anything());
  });

  it("returns [] when droid exec --help exits without a model section", async () => {
    (spawn as any).mockImplementationOnce(() => {
      const EventEmitter = require("node:events");
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("Usage: droid exec\n\nOptions:\n  --help\n"));
        proc.emit("exit", 0);
      }, 0);
      return proc;
    });

    await expect(discoverDroidModels()).resolves.toEqual([]);
  });
});
