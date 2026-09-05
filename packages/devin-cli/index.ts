/*
 * Devin CLI extension for Fusion (local addition).
 *
 * Mirrors the vendored droid-cli extension shape:
 *  - Discovers models from `devin models list --format json` (Free tier by
 *    default; set FUSION_DEVIN_INCLUDE_PAID=1 to advertise every variant).
 *  - Registers provider "devin-cli" whose streamSimple drives `devin acp`
 *    (ACP JSON-RPC over stdio) with a per-session --model flag.
 *  - Resumes ACP sessions via `session/load` (keyed by the pi session id),
 *    so only the newest user turn is sent after the first turn.
 *  - Auto-approves permission requests (mirrors devin-acp.py dangerous mode)
 *    and surfaces `usage_update` context numbers on the final message.
 *
 * Devin CLI authenticates with its own stored credentials; Fusion holds no
 * key material for this provider.
 */
import { AssistantMessageEventStream, type Api, type Model, type TextContent } from "@earendil-works/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_ID = "devin-cli";
const DISCOVERY_TIMEOUT_MS = 15_000;
const SESSION_MAP_PATH = join(homedir(), ".fusion", "agent", "devin-cli-sessions.json");

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

// ── pi-session → ACP-session persistence ────────────────────────────────────

type SessionMapEntry = { acpSessionId: string; cwd?: string; model?: string };
type SessionMap = Record<string, SessionMapEntry>;

function loadSessionMap(): SessionMap {
  try {
    const parsed = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf-8")) as SessionMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSessionMap(map: SessionMap): void {
  try {
    mkdirSync(dirname(SESSION_MAP_PATH), { recursive: true });
    writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2));
  } catch {
    // persistence is best-effort; resume simply degrades to fresh sessions
  }
}

// ── Model discovery ─────────────────────────────────────────────────────────

function runDevinModelsJson(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("devin", ["models", "list", "--format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
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

// ── Prompt helpers ──────────────────────────────────────────────────────────

type FlatMessage = { role: "user" | "assistant"; text: string };

function flattenContext(context: unknown): { prompt: string; latestUserTurn: string | null } {
  const ctx = (context ?? {}) as {
    systemPrompt?: unknown;
    messages?: Array<{ role?: unknown; content?: unknown }>;
  };
  const parts: string[] = [];
  const sys = typeof ctx.systemPrompt === "string" ? ctx.systemPrompt.trim() : "";
  if (sys) parts.push(`<system>\n${sys}\n</system>`);
  const turns: FlatMessage[] = [];
  for (const msg of ctx.messages ?? []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    let text = "";
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((b) => {
          const block = b as { type?: unknown; text?: unknown };
          return block.type === "text" && typeof block.text === "string" ? block.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (text.trim()) turns.push({ role, text });
  }
  for (const turn of turns) {
    parts.push(`${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`);
  }
  parts.push("Assistant:");
  const latestUser = [...turns].reverse().find((t) => t.role === "user");
  return { prompt: parts.join("\n\n"), latestUserTurn: latestUser ? latestUser.text : null };
}

function makeAssistantMessage(model: Model<Api>, text: string, stopReason: "stop" | "length", usage: {
  totalTokens: number;
}): unknown {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }] as TextContent[],
    api: PROVIDER_ID,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: usage.totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

// ── ACP client (minimal; resume + auto-approve + usage) ─────────────────────

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function autoApprove(msg: JsonRpcMessage, send: (m: Record<string, unknown>) => void): void {
  // Mirrors devin-acp.py: pick the first sticky "allow" option (never "once"),
  // falling back to the first option; cancel when the agent offers nothing.
  const params = (msg.params ?? {}) as { options?: Array<{ optionId?: string; name?: string }> };
  const options = Array.isArray(params.options) ? params.options : [];
  const choice =
    options.find((o) => {
      const hay = `${o.optionId ?? ""}${o.name ?? ""}`.toLowerCase();
      return hay.includes("allow") && !o.name?.toLowerCase().includes("once");
    }) ?? (options.length > 0 ? options[0] : undefined);
  const outcome = choice?.optionId
    ? { outcome: "selected", optionId: choice.optionId }
    : { outcome: "cancelled" };
  send({ jsonrpc: "2.0", id: msg.id, result: { outcome } });
}

function streamViaDevinAcp(
  model: Model<Api>,
  context: unknown,
  sessionMap: SessionMap,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    sessionId?: string;
  },
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const piSessionId = typeof options?.sessionId === "string" ? options.sessionId : "";
  const persisted = piSessionId ? sessionMap[piSessionId] : undefined;
  const resumeAcpSessionId = persisted?.acpSessionId ?? "";

  (async () => {
    let proc: ChildProcess | undefined;
    let streamEnded = false;
    let started = false;
    let textOpen = false;
    let accumulated = "";
    let usedTokens = 0;
    const push = (event: unknown) => { if (!streamEnded) stream.push(event as never); };

    const endError = (msg: string) => {
      if (streamEnded) return;
      streamEnded = true;
      const output = makeAssistantMessage(model, `Error: ${msg}`, "stop", { totalTokens: usedTokens });
      stream.push({ type: "done", reason: "stop", message: output } as never);
      try { proc?.kill("SIGKILL"); } catch { /* already dead */ }
    };
    const ensureTextOpen = () => {
      if (!started) {
        started = true;
        push({ type: "start", partial: false } as never);
      }
      if (!textOpen) {
        textOpen = true;
        push({ type: "text_start", partial: false } as never);
      }
    };

    try {
      const cwd = options?.cwd ?? process.cwd();
      proc = spawn("devin", ["acp", "--model", model.id], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      proc.stderr?.on("data", () => { /* diagnostics intentionally dropped */ });
      proc.once("error", (e: Error) => endError(`failed to spawn devin acp: ${e.message}`));
      proc.once("exit", (code: number | null) => {
        if (!streamEnded && code !== 0) endError(`devin acp exited with code ${code}`);
      });
      if (options?.signal) {
        if (options.signal.aborted) { endError("aborted before start"); return; }
        options.signal.addEventListener("abort", () => {
          if (currentSessionId) {
            try { notify("session/cancel", { sessionId: currentSessionId }); } catch { /* best effort */ }
          }
          try { proc?.kill("SIGKILL"); } catch { /* already dead */ }
        });
      }

      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      let nextId = 1;
      let currentSessionId = "";

      const send = (msg: Record<string, unknown>) => {
        proc?.stdin?.write(JSON.stringify(msg) + "\n");
      };
      const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
        const reqId = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(reqId, { resolve, reject });
          const timer = setTimeout(() => {
            if (pending.has(reqId)) {
              pending.delete(reqId);
              reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs);
          timer.unref?.();
          send({ jsonrpc: "2.0", id: reqId, method, params });
        });
      };
      const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: JsonRpcMessage;
        try { msg = JSON.parse(trimmed); } catch { return; }
        // Responses (has id, no method)
        if (msg.method === undefined && typeof msg.id !== "undefined") {
          const entry = pending.get(msg.id as number);
          if (entry) {
            pending.delete(msg.id as number);
            if (msg.error) entry.reject(new Error(msg.error.message ?? "JSON-RPC error"));
            else entry.resolve(msg.result);
          }
          return;
        }
        // Incoming agent requests: auto-approve permissions (dangerous mode,
        // same policy as devin-acp.py); deny any other client callback.
        if (typeof msg.id !== "undefined" && typeof msg.method === "string") {
          if (msg.method === "session/request_permission") autoApprove(msg, send);
          else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not supported" } });
          return;
        }
        if (msg.method === "session/update") {
          const params = msg.params as {
            update?: {
              sessionUpdate?: string;
              content?: { type?: string; text?: string };
              used?: number;
              size?: number;
            };
          } | undefined;
          const update = params?.update;
          if (!update) return;
          if (update.sessionUpdate === "agent_message_chunk") {
            const content = update.content;
            const text = content && content.type === "text" && typeof content.text === "string" ? content.text : "";
            if (text) {
              ensureTextOpen();
              accumulated += text;
              push({ type: "text_delta", delta: text, partial: true } as never);
            }
          } else if (update.sessionUpdate === "usage_update") {
            if (typeof update.used === "number") usedTokens = update.used;
          }
        }
      };

      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", handleLine);

      await request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
        30_000,
      );
      notify("notifications/initialized", {});

      if (resumeAcpSessionId) {
        // Resume: replay the persisted ACP session, then send only the newest
        // user turn. History arrives as user/agent_message_chunk updates and
        // is intentionally not surfaced to the picker stream.
        await request(
          "session/load",
          { sessionId: resumeAcpSessionId, cwd, mcpServers: [] },
          120_000,
        );
        currentSessionId = resumeAcpSessionId;
      } else {
        const newSession = (await request("session/new", { cwd, mcpServers: [] }, 60_000)) as { sessionId?: string };
        currentSessionId = typeof newSession?.sessionId === "string" ? newSession.sessionId : "";
      }
      if (!currentSessionId) throw new Error("devin acp returned no sessionId");

      const { prompt, latestUserTurn } = flattenContext(context);
      const turnText = resumeAcpSessionId
        ? (latestUserTurn ?? prompt)
        : prompt;
      const stop = await request(
        "session/prompt",
        { sessionId: currentSessionId, prompt: [{ type: "text", text: turnText }] },
        Number(process.env.FUSION_DEVIN_TURN_TIMEOUT_MS ?? 1_800_000),
      );
      const stopReason = (stop as { stopReason?: string; usage?: { totalTokens?: number } })?.stopReason;
      const promptUsage = (stop as { usage?: { totalTokens?: number } })?.usage;
      if (typeof promptUsage?.totalTokens === "number" && promptUsage.totalTokens > 0) {
        usedTokens = promptUsage.totalTokens;
      }

      if (piSessionId && !resumeAcpSessionId) {
        sessionMap[piSessionId] = { acpSessionId: currentSessionId, cwd, model: model.id };
        saveSessionMap(sessionMap);
      }

      if (!streamEnded) {
        ensureTextOpen();
        push({ type: "text_end", partial: false } as never);
        streamEnded = true;
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAssistantMessage(model, accumulated, stopReason === "max_tokens" ? "length" : "stop", { totalTokens: usedTokens }),
        } as never);
      }
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    } catch (error) {
      // A failed resume (e.g. session gone after cleanup) is retried once as a
      // fresh session; if that also fails, surface the error.
      if (resumeAcpSessionId && !streamEnded) {
        try { proc?.kill("SIGKILL"); } catch { /* already dead */ }
        if (piSessionId) delete sessionMap[piSessionId];
        saveSessionMap(sessionMap);
        try {
          proc = spawn("devin", ["acp", "--model", model.id], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          });
          proc.once("error", (e: Error) => endError(`failed to spawn devin acp: ${e.message}`));
          proc.once("exit", (code: number | null) => {
            if (!streamEnded && code !== 0) endError(`devin acp exited with code ${code}`);
          });
          const rl2 = createInterface({ input: proc.stdout! });
          rl2.on("line", handleLine);
          await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, 30_000);
          notify("notifications/initialized", {});
          const fresh = (await request("session/new", { cwd, mcpServers: [] }, 60_000)) as { sessionId?: string };
          currentSessionId = typeof fresh?.sessionId === "string" ? fresh.sessionId : "";
          if (!currentSessionId) throw new Error("devin acp returned no sessionId");
          const { prompt: flatPrompt } = flattenContext(context);
          const stopRetry = await request(
            "session/prompt",
            { sessionId: currentSessionId, prompt: [{ type: "text", text: flatPrompt }] },
            Number(process.env.FUSION_DEVIN_TURN_TIMEOUT_MS ?? 1_800_000),
          );
          const retryReason = (stopRetry as { stopReason?: string })?.stopReason;
          if (piSessionId) {
            sessionMap[piSessionId] = { acpSessionId: currentSessionId, cwd, model: model.id };
            saveSessionMap(sessionMap);
          }
          if (!streamEnded) {
            ensureTextOpen();
            push({ type: "text_end", partial: false } as never);
            streamEnded = true;
            stream.push({
              type: "done",
              reason: "stop",
              message: makeAssistantMessage(model, accumulated, retryReason === "max_tokens" ? "length" : "stop", { totalTokens: usedTokens }),
            } as never);
          }
          try { proc.kill("SIGTERM"); } catch { /* already dead */ }
          return;
        } catch (retryError) {
          endError(retryError instanceof Error ? retryError.message : String(retryError));
          return;
        }
      }
      endError(error instanceof Error ? error.message : String(error));
    }
  })();

  return stream;
}

export default async function (pi: {
  registerProvider: (id: string, config: unknown) => void;
}) {
  let models: DevinModel[] = [];
  try {
    models = await discoverDevinModels();
  } catch (err) {
    console.warn("[devin-cli] model discovery failed; registering empty provider", err);
  }

  const sessionMap = loadSessionMap();

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "devin-cli",
    apiKey: "unused",
    api: PROVIDER_ID,
    models,
    streamSimple: ((
      model: Model<Api>,
      context: unknown,
      options?: { cwd?: string; signal?: AbortSignal; sessionId?: string },
    ) => streamViaDevinAcp(model, context, sessionMap, options)) as unknown,
  });
}
