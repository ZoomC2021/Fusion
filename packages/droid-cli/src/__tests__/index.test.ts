import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const runtimeMocks = vi.hoisted(() => {
  return {
    streamViaCli: vi.fn(() => ({ push: vi.fn(), end: vi.fn() })),
    discoverDroidModels: vi.fn(async () => ["droid-pro", "droid-max"]),
    validateCliPresenceAsync: vi.fn(async () => ({ ok: true })),
    validateCliAuthAsync: vi.fn(async () => undefined),
    killAllProcesses: vi.fn(),
    getCustomToolDefs: vi.fn(() => [
      { name: "fn_read", description: "Read", inputSchema: { type: "object" } },
    ]),
    toolsFromContext: vi.fn((tools?: readonly ToolDescriptor[]) =>
      Array.isArray(tools)
        ? tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          }))
        : [],
    ),
    writeMcpConfig: vi.fn((_: unknown, hash: string) => `/tmp/droid-mcp-${hash}.json`),
  };
});

vi.mock("@fusion-plugin-examples/droid-runtime", () => runtimeMocks);

const flushAsyncRegistration = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("droid-cli extension entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    runtimeMocks.discoverDroidModels.mockResolvedValue(["droid-pro", "droid-max"]);
    runtimeMocks.validateCliPresenceAsync.mockResolvedValue({ ok: true });
    runtimeMocks.validateCliAuthAsync.mockResolvedValue(undefined);
    runtimeMocks.toolsFromContext.mockImplementation((tools?: readonly ToolDescriptor[]) =>
      Array.isArray(tools)
        ? tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          }))
        : [],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers provider droid-cli synchronously without starting droid probes or discovery", async () => {
    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    const result = mod.default(mockPi as never);
    await flushAsyncRegistration();

    expect(result).toBeUndefined();
    expect(runtimeMocks.validateCliPresenceAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.validateCliAuthAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.discoverDroidModels).not.toHaveBeenCalled();

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerId, config] = registerProvider.mock.calls[0] as [string, {
      baseUrl: string;
      api: string;
      apiKey: string;
      models: unknown[];
      streamSimple: Function;
    }];

    expect(providerId).toBe("droid-cli");
    expect(config.baseUrl).toBe("droid-cli");
    expect(config.api).toBe("droid-cli");
    expect(config.apiKey).toBe("unused");
    expect(config.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "glm-5.3-flash" })]));
    expect(typeof config.streamSimple).toBe("function");
  });

  it("lets the SDK authenticate streams without spawning extra probe sessions", async () => {
    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };

    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});
    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});
    await flushAsyncRegistration();

    expect(runtimeMocks.validateCliPresenceAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.validateCliAuthAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.discoverDroidModels).not.toHaveBeenCalled();
  });

  it("discovers provider models only when explicitly requested", async () => {
    const mod = await import("../../index");

    await expect(mod.discoverDroidProviderModels()).resolves.toEqual([
      expect.objectContaining({ id: "droid-pro", name: "droid-pro", contextWindow: 200_000, maxTokens: 8_192 }),
      expect.objectContaining({ id: "droid-max", name: "droid-max", contextWindow: 200_000, maxTokens: 8_192 }),
    ]);

    expect(runtimeMocks.discoverDroidModels).toHaveBeenCalledTimes(1);
  });

  it("activates all registered tools on session_start", async () => {
    const sessionStartHandlers: Array<() => Promise<void>> = [];
    const mockPi = {
      registerProvider: vi.fn(),
      on: vi.fn((event: string, handler: () => Promise<void>) => {
        if (event === "session_start") sessionStartHandlers.push(handler);
      }),
      getAllTools: vi.fn(() => [{ name: "find" }, { name: "grep" }]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    expect(sessionStartHandlers).toHaveLength(1);
    await sessionStartHandlers[0]();

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(["find", "grep"]);
  });

  it("falls back to empty models when discovery throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runtimeMocks.discoverDroidModels.mockRejectedValue(new Error("boom"));

    const mod = await import("../../index");
    await expect(mod.discoverDroidProviderModels()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      "[droid-cli] model auto-discovery failed; registering provider with empty model list",
      expect.any(Error),
    );
  });

  it("passes context tools directly to the SDK without legacy config files", async () => {
    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => [{ name: "find" }]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => unknown;
    };

    const context = {
      tools: [
        {
          name: "fn_web_fetch",
          description: "Fetch URL",
          parameters: { type: "object", properties: { url: { type: "string" } } },
        },
      ],
    };

    config.streamSimple({ id: "droid-pro" }, context, { temperature: 0.2 });

    expect(runtimeMocks.writeMcpConfig).not.toHaveBeenCalled();
    expect(runtimeMocks.streamViaCli).toHaveBeenCalledWith(
      { id: "droid-pro" },
      context,
      expect.objectContaining({ temperature: 0.2 }),
    );
  });

  it("falls back to getCustomToolDefs when context tools are missing", async () => {
    runtimeMocks.toolsFromContext.mockReturnValue([]);

    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => [{ name: "ls" }]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };

    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});

    expect(runtimeMocks.getCustomToolDefs).toHaveBeenCalledWith(mockPi);
    expect(runtimeMocks.streamViaCli).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tools: [expect.objectContaining({ name: "fn_read", parameters: { type: "object" } })] }), expect.anything());
  });
});
