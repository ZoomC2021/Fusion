import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

// FNXC:DroidCli 2026-09-06-00:00: mirrors the grok-cli route fixture — the
// auth-store fixture intentionally omits a "droid-cli" key so the toggle path
// (useDroidCli -> configuredProviders.add) is proven on its own, while
// "openai" rows stay configured for the additive-merge assertions below.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{"anthropic":{},"openai":{}}'),
  };
});

vi.mock("../droid-model-cache.js", () => ({
  getDroidPickerModels: vi.fn(),
  DROID_PICKER_PROVIDER_ID: "droid-cli",
}));

import { getDroidPickerModels } from "../droid-model-cache.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";

const mockedGetDroidPickerModels = vi.mocked(getDroidPickerModels);

function setup(
  useDroidCli?: boolean,
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
      getSettings: vi.fn().mockResolvedValue({ useDroidCli }),
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
          { provider: "droid-cli", id: "droid/model", name: "Droid", reasoning: false, contextWindow: 0 },
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

describe("registerModelRoutes droid-cli filter", () => {
  it("filters droid-cli models when useDroidCli is false", async () => {
    const { handler } = setup(false);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(false);
  });

  it("includes droid-cli models when useDroidCli is true", async () => {
    const { handler } = setup(true);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(true);
  });

  it("filters droid-cli models when useDroidCli setting is unset", async () => {
    const { handler } = setup(undefined);
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as { models: Array<{ provider: string }> };
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(false);
  });

  it("includes resolved planning model when settings hierarchy resolves one", async () => {
    const { handler } = setup(false, {
      planningProvider: "openai",
      planningModelId: "gpt-4o",
    });
    const json = vi.fn();

    await handler({}, { json });

    const response = json.mock.calls[0][0] as {
      resolvedPlanningProvider?: string;
      resolvedPlanningModelId?: string;
    };
    expect(response.resolvedPlanningProvider).toBe("openai");
    expect(response.resolvedPlanningModelId).toBe("gpt-4o");
  });
});

/*
FNXC:DroidCli 2026-09-06-00:00:
Merge-site coverage mirroring register-model-routes-grok-cli.test.ts: the
discovered `droid exec --help` catalog rows must merge additively under the
stable "droid-cli" provider id when the toggle is on, and discovery must not
even be attempted when the toggle is off.
*/
describe("registerModelRoutes droid-cli merge", () => {
  it("does not attempt discovery when useDroidCli is false", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([
      { provider: "droid-cli", id: "claude-opus-5", name: "Opus 5", reasoning: false, contextWindow: 0 },
    ]);
    const { handler } = setup(false);
    const response = await invoke(handler);
    expect(mockedGetDroidPickerModels).not.toHaveBeenCalled();
    expect(response.models.some((model) => model.provider === "droid-cli")).toBe(false);
  });

  it("merges discovered droid-cli rows when useDroidCli is true, alongside registry rows", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([
      { provider: "droid-cli", id: "claude-opus-5", name: "Opus 5", reasoning: false, contextWindow: 0 },
      { provider: "droid-cli", id: "gpt-5.5", name: "GPT-5.5", reasoning: false, contextWindow: 0 },
    ]);
    const { handler } = setup(true, {}, {
      registryModels: [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000 }],
    });
    const response = await invoke(handler);
    const droidRows = response.models.filter((m) => m.provider === "droid-cli");
    expect(droidRows.map((m) => m.id).sort()).toEqual(["claude-opus-5", "gpt-5.5"]);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("preserves a pre-existing droid-cli registry row over a colliding discovered row (existing row wins)", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([
      { provider: "droid-cli", id: "droid/model", name: "Discovered (should be dropped)", reasoning: false, contextWindow: 0 },
    ]);
    const { handler } = setup(true, {}, {
      registryModels: [
        { provider: "droid-cli", id: "droid/model", name: "Registry Droid (pre-existing)", reasoning: false, contextWindow: 0 },
      ],
    });
    const response = await invoke(handler);
    const droidRows = response.models.filter((m) => m.provider === "droid-cli" && m.id === "droid/model");
    expect(droidRows).toHaveLength(1);
    expect(droidRows[0]?.name).toBe("Registry Droid (pre-existing)");
  });

  it("degrades to zero discovered rows (existing rows intact) when discovery returns empty", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([]);
    const { handler } = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "droid-cli" && m.id === "droid/model")).toBe(true);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });

  it("degrades to zero discovered rows (never rejects the handler) when discovery throws", async () => {
    mockedGetDroidPickerModels.mockRejectedValue(new Error("droid unavailable"));
    const { handler } = setup(true);
    const response = await invoke(handler);
    expect(response.models.some((m) => m.provider === "openai" && m.id === "gpt-5")).toBe(true);
  });
});

/*
FNXC:DroidCli 2026-09-06-00:00:
The droid binary override lives in the droid runtime plugin's settings store
(droidBinaryPath), not global settings — verify the best-effort plugin-store
read threads it into getDroidPickerModels and degrades safely.
*/
describe("registerModelRoutes droidCliBinaryPath threading", () => {
  it("threads a set droidBinaryPath override from the plugin store into getDroidPickerModels", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([]);
    const { handler } = setup(true, undefined, { droidPluginSettings: { droidBinaryPath: "/opt/droid/droid" } });
    await invoke(handler);
    expect(mockedGetDroidPickerModels).toHaveBeenCalledWith({ binaryPath: "/opt/droid/droid" });
  });

  it("passes binaryPath: undefined when the plugin store reports no override (PATH auto-detection preserved)", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([]);
    const { handler } = setup(true, undefined, { droidPluginSettings: {} });
    await invoke(handler);
    expect(mockedGetDroidPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("passes binaryPath: undefined when the plugin override is blank, and never throws on a missing plugin store", async () => {
    mockedGetDroidPickerModels.mockResolvedValue([]);
    const { handler } = setup(true, undefined, { droidPluginSettings: { droidBinaryPath: "   " } });
    await invoke(handler);
    expect(mockedGetDroidPickerModels).toHaveBeenCalledWith({ binaryPath: undefined });
  });

  it("does not consult the plugin store (or discovery) when useDroidCli is false", async () => {
    const { handler } = setup(false, undefined, { droidPluginSettings: { droidBinaryPath: "/opt/droid/droid" } });
    await invoke(handler);
    expect(mockedGetDroidPickerModels).not.toHaveBeenCalled();
  });
});
