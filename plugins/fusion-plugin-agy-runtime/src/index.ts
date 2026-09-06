import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { probeAgyBinary } from "./probe.js";
import { discoverAgyProviderModels } from "./provider.js";
import { AgyRuntimeAdapter } from "./runtime-adapter.js";

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-agy-runtime",
    name: "Antigravity CLI Runtime Plugin",
    version: "0.1.0",
    description: "Antigravity CLI (agy) runtime support for Fusion",
    runtime: {
      runtimeId: "agy",
      name: "Antigravity CLI Runtime",
      version: "0.1.0",
    },
  },
  state: "installed",
  hooks: {},
  runtime: {
    metadata: {
      runtimeId: "agy",
      name: "Antigravity CLI Runtime",
      version: "0.1.0",
    },
    factory: async (ctx) => new AgyRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined),
  },
  cliProviders: [
    {
      providerId: "agy-cli",
      displayName: "Antigravity CLI",
      binaryName: "agy",
      providerType: "cli",
      statusRoute: "/providers/agy-cli/status",
      authRoute: "/auth/agy-cli",
      actions: [
        { actionId: "enable", label: "Enable", actionType: "enable", method: "POST", route: "/auth/agy-cli" },
        { actionId: "disable", label: "Disable", actionType: "disable", method: "POST", route: "/auth/agy-cli" },
        { actionId: "test", label: "Test", actionType: "test", method: "GET", route: "/providers/agy-cli/status" },
      ],
      probe: async () => {
        const status = await probeAgyBinary();
        return {
          available: status.available,
          authenticated: status.authenticated,
          binaryPath: status.binaryPath,
          binaryName: status.binaryName,
          version: status.version,
          reason: status.reason,
        };
      },
      discoverModels: discoverAgyProviderModels,
      runtime: {
        runtimeId: "agy",
        createAdapter: async (ctx) => new AgyRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined),
      },
    },
  ],
});

export default plugin;
export { probeAgyBinary } from "./probe.js";
export { discoverAgyProviderModels } from "./provider.js";
export type { AgyBinaryStatus } from "./types.js";
