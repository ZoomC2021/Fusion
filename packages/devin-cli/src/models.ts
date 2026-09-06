import { superviseSpawn } from "@fusion/core";
const DISCOVERY_TIMEOUT_MS = 15_000;
type DevinVariant = {
  model_uid?: string;
  label?: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  cost_tier?: string;
};
type DevinFamily = { family_label?: string; slug?: string; variants?: DevinVariant[] };

type DevinModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

/* FNXC:DevinCli 2026-09-06-04:36:
 * Session creation must never run model discovery. Keep known local free models
 * available when the CLI is absent or discovery fails; unknown configured ids
 * use the registry's provider-template fallback. Limits are conservative defaults.
 */
export const STATIC_MODELS: DevinModel[] = ["glm-5-2", "swe-1-7", "swe-1-7-medium"].map((id) => ({
  id, name: `${id} (Free)`, reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 32_000,
}));

// ── Model discovery ─────────────────────────────────────────────────────────

export function runDevinModelsJson(): Promise<string> {
  return new Promise((resolve, reject) => {
    const managed = superviseSpawn("devin", ["models", "list", "--format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const proc = managed.child;
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { managed.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error("devin models list timed out"));
    }, DISCOVERY_TIMEOUT_MS);
    proc.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { err += c.toString(); });
    proc.once("error", (e) => { clearTimeout(timer); reject(e); });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`devin models list exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

function parseDevinModels(json: string): DevinModel[] {
  const parsed = JSON.parse(json) as { families?: DevinFamily[] };
  const includePaid = process.env.FUSION_DEVIN_INCLUDE_PAID === "1";
  const models: DevinModel[] = [];
  const seen = new Set<string>();
  for (const fam of parsed.families ?? []) {
    for (const v of fam.variants ?? []) {
      const id = typeof v.model_uid === "string" ? v.model_uid.trim() : "";
      if (!id || seen.has(id)) continue;
      const tier = (v.cost_tier ?? "").toLowerCase();
      if (!includePaid && !tier.includes("free")) continue;
      seen.add(id);
      const label = v.label || fam.family_label || id;
      models.push({
        id,
        name: tier.includes("free") ? `${label} (Free)` : `${label} (${fam.family_label ?? id})`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: typeof v.max_context_tokens === "number" ? v.max_context_tokens : 200_000,
        maxTokens: typeof v.max_output_tokens === "number" ? v.max_output_tokens : 32_000,
      });
    }
  }
  return models;
}

export async function discoverDevinModels(): Promise<DevinModel[]> {
  const raw = await runDevinModelsJson();
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("devin models list produced no JSON");
  return parseDevinModels(raw.slice(start));
}
