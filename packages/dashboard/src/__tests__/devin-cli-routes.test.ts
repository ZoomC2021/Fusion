import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../devin-cli-probe.js", () => ({ probeDevinCli: vi.fn() }));
import { probeDevinCli } from "../devin-cli-probe.js";
import { registerAuthRoutes } from "../routes/register-auth-routes.js";
function setup(initial: boolean | undefined) {
  let enabled = initial;
  const handlers = new Map<string, (req: unknown, res: { json: (data: unknown) => void }) => Promise<void>>();
  const router = Object.fromEntries(["get", "post", "delete"].map(method => [method, (path: string, handler: never) => handlers.set(method + path, handler)]));
  const update = vi.fn(async (patch: { useDevinCli: boolean }) => { enabled = patch.useDevinCli; return patch; });
  registerAuthRoutes({ router, store: { getGlobalSettingsStore: () => ({ getSettings: async () => ({ useDevinCli: enabled }) }), updateGlobalSettings: update }, options: {}, rethrowAsApiError: (e: unknown) => { throw e; } } as never);
  return { handlers, update };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(probeDevinCli).mockResolvedValue({ binary: { available: true, version: "devin test" }, authenticated: true }); });
it.each([true, false, undefined])("reports readiness separately from enable setting %j", async enabled => {
  const { handlers } = setup(enabled); const json = vi.fn(); await handlers.get("get/providers/devin-cli/status")!({}, { json });
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ enabled: enabled !== false, ready: enabled !== false, authenticated: true }));
});
it("does not call an unauthenticated installation ready", async () => {
  vi.mocked(probeDevinCli).mockResolvedValue({ binary: { available: true }, authenticated: false });
  const { handlers } = setup(true); const json = vi.fn(); await handlers.get("get/providers/devin-cli/status")!({}, { json }); expect(json).toHaveBeenCalledWith(expect.objectContaining({ ready: false }));
});
it("validates enable payloads and permits disabling an absent binary", async () => {
  const { handlers, update } = setup(true); const handler = handlers.get("post/auth/devin-cli")!;
  await expect(handler({ body: { enabled: "yes" } }, { json: vi.fn() })).rejects.toThrow("boolean"); expect(update).not.toHaveBeenCalled();
  vi.mocked(probeDevinCli).mockResolvedValue({ binary: { available: false }, authenticated: false });
  await expect(handler({ body: { enabled: true } }, { json: vi.fn() })).rejects.toThrow("Install");
  await handler({ body: { enabled: false } }, { json: vi.fn() }); expect(update).toHaveBeenCalledWith({ useDevinCli: false });
});
