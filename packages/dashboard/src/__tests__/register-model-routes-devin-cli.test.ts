import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(), access: vi.fn().mockResolvedValue(undefined), readFile: vi.fn().mockResolvedValue('{"openai":{}}') }));
import { registerModelRoutes } from "../routes/register-model-routes.js";
function setup(
  useDevinCli?: boolean,
  mergedSettings: Record<string, unknown> = {},
  options?: {
    registryModels?: Array<{ provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }>;
    droidPluginSettings?: Record<string, unknown>;
  },
) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    // FNXC:ModelCatalog 2026-08-23-23:12: registerModelRoutes also registers POST /models/refresh (FN-019 operator catalog refresh), so a router fake exposing only `get` throws before any GET handler is captured.
    post: vi.fn(),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({
      getSettings: vi.fn().mockResolvedValue({ useDevinCli }),
    }),
    getSettingsFast: vi.fn().mockResolvedValue(mergedSettings),
    // FNXC:DroidCli 2026-09-06-00:00: the droid binary override lives in the
    // droid runtime plugin's settings store, not global settings.
    getPluginStore: vi.fn(() => ({
      getPlugin: vi.fn(async () =>
        options?.droidPluginSettings !== undefined
          ? { settings: options.droidPluginSettings }
          : undefined,
      ),
    })),
  };

  const runtimeLogger = {
    child: vi.fn(() => ({ warn: vi.fn() })),
  };

  const modelRegistry = {
    refresh: vi.fn(),
    getAvailable: vi.fn(
      () =>
        options?.registryModels ?? [
          { provider: "devin-cli", id: "glm-5-2", name: "Droid", reasoning: false, contextWindow: 0 },
          { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 },
        ],
    ),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry } as never,
  } as never);

  return { handler: getHandlers.get("/models")!, modelRegistry };
}

async function invoke(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({}, { json });
  return json.mock.calls[0][0] as { models: Array<{ provider: string; id: string; name: string }> };
}

afterEach(() => {
  vi.clearAllMocks();
});


describe("Devin catalog gate", () => {
  it.each([true, undefined])("retains defaults and deduplicates registry models with enabled=%j", async enabled => {
    const { handler } = setup(enabled); const result = await invoke(handler);
    const rows = result.models.filter(model => model.provider === "devin-cli");
    expect(rows.map(model => model.id).sort()).toEqual(["glm-5-2", "swe-1-7", "swe-1-7-medium"]);
  });
  it("hides already-registered Devin models when disabled", async () => {
    const { handler } = setup(false); expect((await invoke(handler)).models.some(model => model.provider === "devin-cli")).toBe(false);
  });
});
