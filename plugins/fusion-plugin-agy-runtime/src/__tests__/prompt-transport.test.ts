import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchAgyPrompt } from "../prompt-transport.js";

function fakeSupervisor() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const supervise = vi.fn(() => ({ child, pid: 44, pgid: 44, kill: vi.fn(), waitExit: async () => ({ code: 0, signal: null }) }));
  return { child, supervise };
}

const INIT = '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.7-flash-low","cwd":"/tmp"}}';
const RESULT = '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"OK\\n","usage":{"total_tokens":1}}}';

describe("launchAgyPrompt", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses a supervised shell:false cwd-bound direct launch with the agy stream-json argv", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hello", model: "agy-cli/gemini-3.7-flash-low", tools: "readonly" }, { supervise: supervise as never, platform: "linux" });
    expect(supervise).toHaveBeenCalledWith(
      "agy",
      expect.arrayContaining(["--dangerously-skip-permissions", "--mode", "plan", "--model", "gemini-3.7-flash-low", "--input-format", "stream-json", "--output-format", "stream-json"]),
      expect.objectContaining({ shell: false, cwd: "/tmp", maxLifetimeMs: Number.POSITIVE_INFINITY }),
    );
    const argv = (supervise.mock.calls[0] as unknown[])[1] as string[];
    expect(argv).not.toContain("--conversation");
    child.stdout.write(`${INIT}\n`);
    child.stdout.write(`${RESULT}\n`);
    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ conversationId: "c1", text: "OK\n" });
  });

  it("writes exactly one NDJSON user event to stdin then closes stdin", async () => {
    const { child, supervise } = fakeSupervisor();
    const stdinChunks: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString("utf-8")));
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "do the thing" }, { supervise: supervise as never, platform: "linux" });
    child.stdout.write(`${RESULT}\n`);
    child.emit("close", 0);
    await promise;
    const payload = stdinChunks.join("");
    expect(payload).toBe(`${JSON.stringify({ event: "user", message: { content: "do the thing" } })}\n`);
  });

  it("uses --mode accept-edits for coding and --mode plan for readonly/unset", async () => {
    const coding = fakeSupervisor();
    const codingPromise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi", tools: "coding" }, { supervise: coding.supervise as never, platform: "linux" });
    expect((coding.supervise.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(["--mode", "accept-edits"]));
    coding.child.stdout.write(`${RESULT}\n`);
    coding.child.emit("close", 0);
    await codingPromise;

    const readonly = fakeSupervisor();
    const readonlyPromise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi", tools: "readonly" }, { supervise: readonly.supervise as never, platform: "linux" });
    expect((readonly.supervise.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(["--mode", "plan"]));
    readonly.child.stdout.write(`${RESULT}\n`);
    readonly.child.emit("close", 0);
    await readonlyPromise;

    const unset = fakeSupervisor();
    const unsetPromise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: unset.supervise as never, platform: "linux" });
    expect((unset.supervise.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(["--mode", "plan"]));
    unset.child.stdout.write(`${RESULT}\n`);
    unset.child.emit("close", 0);
    await unsetPromise;
  });

  it("passes --conversation <id> when resuming and strips the agy-cli/ model prefix", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "more", model: "agy-cli/gemini-3.7-flash-high", conversationId: "c1" }, { supervise: supervise as never, platform: "linux" });
    expect((supervise.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(["--conversation", "c1", "--model", "gemini-3.7-flash-high"]));
    child.stdout.write(`${RESULT}\n`);
    child.emit("close", 0);
    await promise;
  });

  it("defaults the model to gemini-3.7-flash-high when none is given", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    expect((supervise.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(["--model", "gemini-3.7-flash-high"]));
    child.stdout.write(`${RESULT}\n`);
    child.emit("close", 0);
    await promise;
  });

  it("rejects on a non-SUCCESS result event", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    const assertion = expect(promise).rejects.toThrow(/invalid model selection/);
    child.stdout.write('{"event":"result","result":{"conversation_id":"","status":"ERROR","error":"invalid model selection"}}\n');
    child.emit("close", 1);
    await assertion;
  });

  it("does not let an empty-string result conversation_id clobber the init id", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    child.stdout.write(`${INIT}\n`);
    // result-error fixture shape: conversation_id "" with status ERROR — must not overwrite the init id.
    child.stdout.write('{"event":"result","result":{"conversation_id":"","status":"ERROR","error":"boom"}}\n');
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(/boom/);
    // The rejection discards the resolved value, so re-run a SUCCESS path with an empty conversation_id to prove the id is retained.
    const { child: child2, supervise: supervise2 } = fakeSupervisor();
    const promise2 = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise2 as never, platform: "linux" });
    child2.stdout.write(`${INIT}\n`);
    child2.stdout.write('{"event":"result","result":{"conversation_id":"","status":"SUCCESS","response":"OK\\n"}}\n');
    child2.emit("close", 0);
    await expect(promise2).resolves.toMatchObject({ conversationId: "c1", text: "OK\n" });
  });

  it("rejects when the stream ends without a result event", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    const assertion = expect(promise).rejects.toThrow(/without a result event/);
    child.stdout.write(`${INIT}\n`);
    child.emit("close", 0);
    await assertion;
  });

  it("rejects on a non-zero exit with stderr", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    const assertion = expect(promise).rejects.toThrow(/agy CLI exited 2/);
    child.stderr.write("boom");
    child.emit("close", 2);
    await assertion;
  });

  it("surfaces an ENOENT spawn error", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    const assertion = expect(promise).rejects.toThrow(/ENOENT/);
    child.emit("error", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));
    await assertion;
  });

  it("fires the first-line timeout when no stdout arrives", async () => {
    vi.useFakeTimers();
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    const assertion = expect(promise).rejects.toThrow(/first-line timeout/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    child.emit("close", null);
  });

  it("fires the inactivity timeout after the first line when no further output arrives", async () => {
    vi.useFakeTimers();
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi" }, { supervise: supervise as never, platform: "linux" });
    const assertion = expect(promise).rejects.toThrow(/inactivity timeout/);
    child.stdout.write(`${INIT}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    child.emit("close", null);
  });

  it("kills the subprocess on abort and rejects", async () => {
    const { child, supervise } = fakeSupervisor();
    const controller = new AbortController();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi", signal: controller.signal }, { supervise: supervise as never, platform: "linux" });
    const kill = supervise.mock.results[0].value.kill as ReturnType<typeof vi.fn>;
    const assertion = expect(promise).rejects.toThrow(/aborted/);
    controller.abort();
    child.emit("close", null);
    await assertion;
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("preserves bracketed model parameters through a validated Windows cmd shim", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi", binary: "C:\\agy\\agy.CMD", model: "gemini-3.7-flash-low[context=1m]" }, { supervise: supervise as never, platform: "win32" });
    expect(supervise).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", expect.stringContaining("gemini-3.7-flash-low[context=1m]")], expect.objectContaining({ shell: false, windowsVerbatimArguments: true }));
    child.stdout.write(`${RESULT}\n`);
    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ text: "OK\n" });
  });

  it("uses Windows PowerShell for a .ps1 shim", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchAgyPrompt({ cwd: "/tmp", prompt: "hi", binary: "C:\\agy\\agy.ps1" }, { supervise: supervise as never, platform: "win32", resolvePowerShell: () => "powershell.exe" });
    expect(supervise).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-NoProfile", "-File", "C:\\agy\\agy.ps1"]), expect.not.objectContaining({ windowsVerbatimArguments: expect.anything() }));
    child.stdout.write(`${RESULT}\n`);
    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ text: "OK\n" });
  });
});
