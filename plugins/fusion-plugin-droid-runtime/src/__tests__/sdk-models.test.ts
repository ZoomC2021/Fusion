import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), models: vi.fn() }));
vi.mock("@factory/droid-sdk/node", () => ({
  listModels: state.models,
  ProcessTransport: class { connect = state.connect; close = state.close; },
}));
import { discoverDroidImageModels } from "../sdk-models.js";
beforeEach(() => { vi.resetAllMocks(); state.connect.mockResolvedValue(undefined); state.close.mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());
it("trusts only explicit active image capability and closes its transport", async () => {
  state.models.mockResolvedValue([
    { id: "vision", noImageSupport: false }, { id: "text", noImageSupport: true },
    { id: "unknown" }, { id: "disabled", noImageSupport: false, disabled: true },
  ]);
  expect(await discoverDroidImageModels()).toEqual(["vision"]);
  expect(state.close).toHaveBeenCalled();
});
it("cleans up rejected capability discovery", async () => {
  state.models.mockRejectedValue(new Error("offline"));
  await expect(discoverDroidImageModels()).rejects.toThrow("offline");
  expect(state.close).toHaveBeenCalled();
});
it.each(["timeout", "abort"])("closes stalled discovery on %s", async (mode) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let rejectConnect: (error: Error) => void = () => {};
  state.connect.mockImplementation(() => new Promise((_, reject) => { rejectConnect = reject; }));
  state.close.mockImplementation(async () => rejectConnect(new Error("closed")));
  const result = discoverDroidImageModels({ timeoutMs: 10, signal: controller.signal });
  const assertion = expect(result).rejects.toThrow();
  if (mode === "abort") controller.abort(); else await vi.advanceTimersByTimeAsync(11);
  await assertion;
  expect(state.models).not.toHaveBeenCalled();
});

it.each(["timeout", "abort"])("rejects promptly on %s when closing does not settle a pending catalog RPC", async (mode) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let rejectRpc: (error: Error) => void = () => {};
  state.models.mockImplementation(() => new Promise((_, reject) => { rejectRpc = reject; }));
  let outcome: unknown;
  void discoverDroidImageModels({ timeoutMs: 10, signal: controller.signal }).catch(error => { outcome = error; });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.models).toHaveBeenCalledOnce();
  if (mode === "abort") controller.abort(new Error("cancelled"));
  await vi.advanceTimersByTimeAsync(11);
  expect(outcome).toBeInstanceOf(Error);
  expect(state.close).toHaveBeenCalled();
  rejectRpc(new Error("late SDK rejection"));
  await vi.advanceTimersByTimeAsync(0);
});
