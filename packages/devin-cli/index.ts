import { STATIC_MODELS } from "./src/models.js";
import { streamViaDevinAcp } from "./src/stream.js";
export { discoverDevinModels } from "./src/models.js";

/* FNXC:DevinCli 2026-09-06-04:47:
 * Registration is synchronous and probe-free. Only selected streams start ACP
 * and their tool bridges; explicit status/model requests own CLI discovery.
 */
export default function (pi: { registerProvider: (id: string, config: unknown) => void }) {
  pi.registerProvider("devin-cli", {
    baseUrl: "devin-cli", apiKey: "unused", api: "devin-cli",
    models: STATIC_MODELS.map(model => ({ ...model, input: [...model.input], cost: { ...model.cost } })),
    streamSimple: streamViaDevinAcp,
  });
}
