import { listModels, ProcessTransport } from "@factory/droid-sdk/node";

/** Explicit, bounded capability discovery; never called during registration. */
export async function discoverDroidImageModels(options: { binaryPath?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string[]> {
  options.signal?.throwIfAborted();
  const transport = new ProcessTransport({ droidExecPath: options.binaryPath ?? "droid", cwd: process.cwd() });
  const abort = () => { void transport.close().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => { void transport.close().catch(() => {}); }, options.timeoutMs ?? 10_000);
  deadline.unref();
  try {
    await transport.connect();
    options.signal?.throwIfAborted();
    const models = await listModels({ transport });
    return models.filter((model) => !model.disabled && model.noImageSupport === false).map((model) => model.id);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(deadline);
    await transport.close().catch(() => {});
  }
}
