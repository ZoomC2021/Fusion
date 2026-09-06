import { listModels, ProcessTransport } from "@factory/droid-sdk/node";

/** Explicit, bounded capability discovery; never called during registration. */
export async function discoverDroidImageModels(options: { binaryPath?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string[]> {
  options.signal?.throwIfAborted();
  const transport = new ProcessTransport({ droidExecPath: options.binaryPath ?? "droid", cwd: process.cwd() });
  let stopError: Error | undefined;
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  function stop(error: Error) {
    if (stopError) return;
    stopError = error;
    rejectStopped(error);
    void transport.close().catch(() => {});
  }
  const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Droid model discovery aborted."));
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => stop(new Error("Droid model discovery timed out.")), options.timeoutMs ?? 10_000);
  deadline.unref();
  const discovery = (async () => {
    await transport.connect();
    if (stopError) {
      // A connection may finish after timeout closed the earlier transport.
      await transport.close().catch(() => {});
      throw stopError;
    }
    const models = await listModels({ transport });
    if (stopError) throw stopError;
    return models.filter((model) => !model.disabled && model.noImageSupport === false).map((model) => model.id);
  })();
  try {
    // SDK transport.close suppresses onError, so it cannot be relied upon to
    // reject an in-flight listModels RPC. The race also observes late rejection.
    return await Promise.race([discovery, stopped]);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(deadline);
    await transport.close().catch(() => {});
  }
}
