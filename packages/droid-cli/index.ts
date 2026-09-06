import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  streamViaCli,
  discoverDroidModels,
  killAllProcesses,
  getCustomToolDefs,
} from "@fusion-plugin-examples/droid-runtime";

process.on("exit", killAllProcesses);

const PROVIDER_ID = "droid-cli";

type DiscoveredModel = { id: string; name: string; reasoning: boolean; input: Array<"text" | "image">; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
let discoveredModelsPromise: Promise<DiscoveredModel[]> | undefined;
type StreamSimpleHandler = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]>;

export async function discoverDroidProviderModels() {
  if (!discoveredModelsPromise) {
    discoveredModelsPromise = (async () => {
      try {
        const ids = Array.from(new Set(await discoverDroidModels()));
        if (ids.length === 0) return [];
        return toProviderModels(ids);
      } catch (error) {
        console.warn("[droid-cli] model auto-discovery failed; registering provider with empty model list", error);
        return [];
      }
    })();
  }
  return discoveredModelsPromise;
}

function toProviderModels(ids: string[]): DiscoveredModel[] {
  return ids.map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  }));
}

/*
 * FNXC:CliRuntime 2026-09-06-01:30:
 * Static, compile-time placeholder catalog so the pi model registry has at least one
 * droid-cli row at boot (see the default-export note below). Zero `droid` spawns:
 * these are constants, not discovery output. Capabilities/costs are intentionally
 * conservative placeholders — the dashboard picker routes still use live discovery.
 */
const STATIC_PLACEHOLDER_MODELS: DiscoveredModel[] = [
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.2-fast",
  "swe-1-7",
  "swe-1-7-medium",
].map((id) => ({
  id,
  name: id,
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
}));

function registerDroidProvider(pi: ExtensionAPI, models: DiscoveredModel[]) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "droid-cli",
    apiKey: "unused",
    api: "droid-cli",
    models,
    streamSimple: ((model, context, options) => {
      const requestContext = context as typeof context & { tools?: unknown[] };
      const tools = requestContext.tools ?? getCustomToolDefs(pi).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.input_schema,
      }));
      return streamViaCli(
        model,
        { ...context, tools } as never,
        options as never,
      ) as unknown as ReturnType<StreamSimpleHandler>;
    }) as StreamSimpleHandler,
  });
}

export default function (pi: ExtensionAPI) {
  /*
  FNXC:CliRuntime 2026-06-21-18:43:
  Engine and dashboard startup must not start the local Droid CLI merely because the optional extension loaded. Register the provider synchronously with fallback models, let the SDK authenticate an actual droid stream, and leave model discovery to explicit picker/status callers so boot with `useDroidCli` enabled still performs zero `droid` spawns.

  FNXC:CliRuntime 2026-06-21-12:00:
  Engine and dashboard startup must not wait for local Droid CLI probes. Every surviving validation/discovery helper remains fire-and-forget, bounded, non-interactive, and resolve-only so a missing or wedged `droid` binary cannot stall extension loading or a session start.

  FNXC:CliRuntime 2026-09-06-01:30:
  Local integration: the engine's configured-model resolution (resolveConfiguredModel in
  packages/engine/src/pi.ts) treats a provider with zero registered models as unknown and refuses
  every lane that names it ("was not found in the pi model registry"), so an empty registration made
  droid-cli unusable for planning/validator/merger lanes even though the dashboard picker merged
  discovered models at the route layer. Register a small STATIC placeholder catalog instead: no
  `droid` spawn happens here (compile-time data only, preserving the zero-boot-spawn constraint),
  and the registry's provider-template fallback accepts any configured droid model id on the fly.
  Live discovery still belongs to the picker/status routes via getDroidPickerModels.
  */
  pi.on("session_start", async () => {
    const allTools = pi.getAllTools();
    if (Array.isArray(allTools)) {
      pi.setActiveTools(allTools.map((t: { name: string }) => t.name));
    }
  });

  try {
    registerDroidProvider(pi, STATIC_PLACEHOLDER_MODELS);
  } catch (err) {
    console.error("[droid-cli] Failed to register provider:", err);
  }
}
