import { createAssistantMessageEventStream, type AssistantMessage, type Api, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { superviseSpawn, GlobalSettingsStore, type SupervisedChild } from "@fusion/core";
import { createInterface, type Interface } from "node:readline";
import { createEventBridge } from "@fusion-plugin-examples/acp-runtime/event-bridge";
import { startFusionToolBridge, type FusionToolBridge } from "@fusion-plugin-examples/acp-runtime/tool-bridge";
import { createDevinMcpConfig } from "./mcp-config.js";
import { acquireSession, pruneSessions } from "./sessions.js";

interface Context {
  systemPrompt?: string;
  messages?: Array<{ role: string; content: unknown; toolCallId?: string; toolName?: string }>;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
export interface DevinOptions { cwd?: string; signal?: AbortSignal; sessionId?: string }
interface Rpc { id?: number | string; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown> }
class ResponseError extends Error {}
let lastPrune = 0;

export function flattenContext(context: Context): { prompt: string; latestUserTurn: string | undefined } {
  const render = (content: unknown): string => typeof content === "string" ? content : JSON.stringify(content);
  const messages = context.messages ?? [];
  return {
    prompt: [context.systemPrompt ? `<system>\n${context.systemPrompt}\n</system>` : "", ...messages.map(msg =>
      `${msg.role}${msg.toolCallId ? ` (${msg.toolName ?? "tool"}, ${msg.toolCallId})` : ""}: ${render(msg.content)}`)].filter(Boolean).join("\n\n"),
    latestUserTurn: messages.at(-1)?.role === "user" ? render(messages.at(-1)!.content) : undefined,
  };
}

/* FNXC:DevinCli 2026-09-06-04:47:
 * ACP custom tools hand off to pi's normal execution loop. The shared MCP
 * bridge only records the requested call here; Fusion runs it after toolUse.
 * Native Devin tools remain native and appear as thinking activity, never as
 * executable pi tool calls. Every exit drains RPCs, bridge, process and lease.
 */
export function streamViaDevinAcp(model: Model<Api>, context: Context, options: DevinOptions = {}) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant", api: "devin-cli", provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    let child: SupervisedChild | undefined;
    let lines: Interface | undefined;
    let bridge: FusionToolBridge | null = null;
    let mcpConfig: Awaited<ReturnType<typeof createDevinMcpConfig>> | undefined;
    let lease: Awaited<ReturnType<typeof acquireSession>> | undefined;
    let sessionId = "";
    let nextId = 1;
    let accepting = false;
    let handoff: ToolCall | undefined;
    let activeBlock: { type: "text" | "thinking"; index: number; text: string } | undefined;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const send = (msg: object) => { child?.child.stdin?.write(JSON.stringify(msg) + "\n"); };
    const rejectPending = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
    const cancel = () => {
      if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      child?.kill("SIGKILL");
      rejectPending(new Error("Devin turn cancelled"));
    };
    const closeBlock = () => {
      if (!activeBlock) return;
      const { type, index, text } = activeBlock;
      stream.push({ type: type === "text" ? "text_end" : "thinking_end", contentIndex: index, content: text, partial: output });
      activeBlock = undefined;
    };
    const delta = (type: "text" | "thinking", text: string) => {
      if (!accepting || !text) return;
      if (activeBlock?.type !== type) {
        closeBlock();
        activeBlock = { type, index: output.content.length, text: "" };
        output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
        stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: activeBlock.index, partial: output });
      }
      activeBlock.text += text;
      const block = output.content[activeBlock.index]!;
      if (block.type === "text") block.text = activeBlock.text;
      else if (block.type === "thinking") block.thinking = activeBlock.text;
      stream.push({ type: type === "text" ? "text_delta" : "thinking_delta", contentIndex: activeBlock.index, delta: text, partial: output });
    };
    const events = createEventBridge({
      onText: text => delta("text", text), onThinking: text => delta("thinking", text),
      onToolStart: (name, args) => delta("thinking", `\nTool started: ${name} ${JSON.stringify(args).slice(0, 4000)}\n`),
      onToolEnd: (name, failed) => delta("thinking", `\nTool ${failed ? "failed" : "completed"}: ${name}\n`),
    });
    const request = (method: string, params: object, timeoutMs: number): Promise<unknown> => new Promise((resolve, reject) => {
      if (options.signal?.aborted || handoff) { reject(new Error("Devin turn cancelled")); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      send({ jsonrpc: "2.0", id, method, params });
    });
    const cwd = options.cwd ?? process.cwd();
    const { prompt, latestUserTurn } = flattenContext(context);
    try {
      if ((await new GlobalSettingsStore().getSettings()).useDevinCli === false) throw new Error("Devin CLI is disabled in Settings → Authentication");
      if (options.signal?.aborted) throw new Error("Devin turn cancelled before start");
      if (options.sessionId) lease = await acquireSession(options.sessionId, undefined, cancel);
      const saved = await lease?.read();
      const resume = saved?.cwd === cwd && saved.model === model.id && latestUserTurn !== undefined ? saved.acpSessionId : undefined;
      bridge = await startFusionToolBridge((context.tools ?? []).map(tool => ({ ...tool, execute: (id, args) => {
        if (!accepting || handoff) throw new Error("Devin turn is no longer accepting tool calls");
        handoff = { type: "toolCall", id: `devin-${sessionId}-${id}`, name: tool.name, arguments: (args ?? {}) as Record<string, unknown> };
        cancel();
        return { content: [{ type: "text", text: "Tool handed to Fusion." }] };
      } })));
      const mcpServers = bridge ? [bridge.mcpServer] : [];
      if (bridge) mcpConfig = await createDevinMcpConfig(bridge.mcpServer);
      if (options.signal?.aborted) throw new Error("Devin turn cancelled before start");
      const configuredTimeout = Number(process.env.FUSION_DEVIN_TURN_TIMEOUT_MS ?? 1_800_000);
      const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 1_800_000;
      child = superviseSpawn("devin", ["acp", "--model", model.id], { cwd, stdio: ["pipe", "pipe", "pipe"], env: mcpConfig?.env ?? process.env, maxLifetimeMs: timeout + 240_000 });
      child.child.stderr?.on("data", () => undefined);
      child.child.stdin?.on("error", error => rejectPending(error));
      child.child.once("error", error => rejectPending(error));
      child.child.once("exit", code => rejectPending(new Error(`devin acp exited with code ${code}`)));
      options.signal?.addEventListener("abort", cancel, { once: true });
      lines = createInterface({ input: child.child.stdout! });
      lines.on("line", line => {
        let msg: Rpc;
        try { msg = JSON.parse(line); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        if (msg.method === undefined && typeof msg.id === "number") {
          const entry = pending.get(msg.id); pending.delete(msg.id);
          if (msg.error) entry?.reject(new ResponseError(msg.error.message ?? "ACP request rejected")); else entry?.resolve(msg.result);
        } else if (msg.method === "session/update" && accepting && (!msg.params?.sessionId || msg.params.sessionId === sessionId)) {
          const update = msg.params?.update as Parameters<typeof events.handleSessionUpdate>[0];
          if (update?.sessionUpdate === "plan_update" || update?.sessionUpdate === "plan_removed") {
            events.handleSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: update.sessionUpdate === "plan_removed" ? "\nPlan cleared.\n" : `\nPlan updated: ${JSON.stringify(update.plan).slice(0, 64000)}\n` } });
          } else events.handleSessionUpdate(update);
          if (update?.sessionUpdate === "usage_update" && typeof update.used === "number") output.usage.totalTokens = update.used;
        } else if (msg.id !== undefined && msg.method) {
          if (msg.method === "session/request_permission") {
            const choices = msg.params?.options as Array<{ optionId: string; kind?: string }> | undefined;
            const choice = Array.isArray(choices) ? choices.find(o => o.kind === "allow_always") ?? choices.find(o => o.kind === "allow_once") : undefined;
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } } });
          } else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported" } });
        }
      });
      await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, 30_000);
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      let resumed = false;
      if (resume) {
        try { await request("session/load", { sessionId: resume, cwd, mcpServers }, 120_000); sessionId = resume; resumed = true; }
        catch (error) { if (!(error instanceof ResponseError) || options.signal?.aborted) throw error; await lease?.save(undefined); }
      }
      if (!resumed) {
        const created = await request("session/new", { cwd, mcpServers }, 60_000) as { sessionId?: string };
        sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
      }
      if (!sessionId) throw new Error("devin acp returned no sessionId");
      stream.push({ type: "start", partial: output });
      accepting = true;
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: resumed ? latestUserTurn : prompt }] }, timeout) as { stopReason?: string; usage?: { totalTokens?: number } };
      output.stopReason = result?.stopReason === "max_tokens" ? "length" : result?.stopReason === "cancelled" ? "aborted" : "stop";
      if (typeof result?.usage?.totalTokens === "number") output.usage.totalTokens = result.usage.totalTokens;
      await lease?.save({ acpSessionId: sessionId, cwd, model: model.id });
    } catch (error) {
      if (handoff) {
        closeBlock();
        const index = output.content.length;
        output.content.push(handoff);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: handoff, partial: output });
        output.stopReason = "toolUse";
        await lease?.save(undefined);
      } else {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      accepting = false;
      closeBlock();
      options.signal?.removeEventListener("abort", cancel);
      rejectPending(new Error("Devin turn ended"));
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => child?.kill("SIGKILL")),
        Promise.resolve().then(() => lines?.close()),
        Promise.resolve().then(() => bridge?.dispose()),
        Promise.resolve().then(() => mcpConfig?.dispose()),
        Promise.resolve().then(() => lease?.release()),
      ]);
      const failed = cleanup.find(result => result.status === "rejected");
      if (failed?.status === "rejected") {
        output.stopReason = "error";
        output.errorMessage = `Devin cleanup failed: ${String(failed.reason)}`;
      }
      if (Date.now() - lastPrune > 300_000) { lastPrune = Date.now(); void pruneSessions().catch(() => undefined); }
    }
    if (output.stopReason === "error" || output.stopReason === "aborted") stream.push({ type: "error", reason: output.stopReason, error: output });
    else stream.push({ type: "done", reason: output.stopReason, message: output });
  })().catch(error => {
    output.stopReason = "error"; output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: "error", error: output });
  });
  return stream;
}
