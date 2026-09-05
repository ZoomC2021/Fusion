import { launchAgyPrompt } from "./prompt-transport.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult, AgyStreamSession } from "./types.js";

function context(options: AgentRuntimeOptions, names: string[] = []): string {
  const skills = Array.isArray(options.skills) ? options.skills.filter((value) => typeof value === "string" && value.trim()) : [];
  return [
    "Fusion runtime context:",
    `- Tool mode: ${options.tools ?? "readonly"}`,
    skills.length ? `- Requested skills: ${skills.join(", ")}` : "",
    names.length ? `- Fusion MCP tools: ${names.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/*
FNXC:AgyCli 2026-09-06-00:00:
A live agy session is one supervised stream-json process per turn. The
conversation_id from the init event is retained and passed back with
--conversation on the next turn to resume. The system prompt is fused into the
first turn only; subsequent turns send the bare user prompt.
*/
export class AgyRuntimeAdapter implements AgentRuntime {
  readonly id = "agy";
  readonly name = "Antigravity CLI Runtime";
  constructor(private readonly settings?: Record<string, unknown>) {}

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const messages: unknown[] = [];
    const model = (options.defaultModelId?.replace(/^agy-cli\//, "") || "gemini-3.7-flash-high").trim();
    const mode: "accept-edits" | "plan" = options.tools === "coding" ? "accept-edits" : "plan";
    const session: AgyStreamSession = {
      model,
      mode,
      cwd: options.cwd,
      tools: options.tools,
      messages,
      state: { messages },
      conversationId: "",
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      fusedSystemPrompt: [options.systemPrompt?.trim(), context(options)].filter(Boolean).join("\n\n"),
      disposed: false,
      dispose: async () => {
        if (session.disposed) return;
        session.disposed = true;
        session.activeAbortController?.abort();
        if (session.mcpHeartbeatTimer) clearInterval(session.mcpHeartbeatTimer);
        await session.mcpLease?.dispose().catch(() => undefined);
        await session.toolBridge?.dispose().catch(() => undefined);
      },
    };

    // TODO(agy-mcp-bridge): the fn_* tool bridge is added in slice 2 by a
    // separate worker. Until then, a session with Fusion custom tools records
    // a bridge-start-failed degradation so the engine surfaces it the same way
    // Cursor degrades, and the turn still runs tool-less.
    if (options.fusionTools?.length) {
      session.fusionToolBridgeError = { reasonCode: "bridge-start-failed" };
    }

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgyStreamSession, prompt: string, _options?: unknown): Promise<void> {
    if (session.disposed) throw new Error("agy session is disposed.");
    const priorId = session.conversationId;
    const first = !priorId;
    const sent = first ? `${session.fusedSystemPrompt}\n\nUser request:\n${prompt}` : prompt;
    const emitted = new Set<string>();
    const controller = new AbortController();
    session.activeAbortController = controller;
    try {
      const outcome = await launchAgyPrompt({
        binary: typeof this.settings?.agyCliBinaryPath === "string" ? this.settings.agyCliBinaryPath : undefined,
        model: session.model,
        cwd: session.cwd,
        tools: session.tools,
        prompt: sent,
        conversationId: priorId || undefined,
        signal: controller.signal,
        onThinking: session.callbacks.onThinking,
        onToolStart: (name, args) => session.callbacks.onToolStart?.(name, args),
        onToolEnd: (name, isError, result) => session.callbacks.onToolEnd?.(name, isError, result),
        onText: (text) => {
          if (!emitted.has(text)) {
            emitted.add(text);
            session.callbacks.onText?.(text);
          }
        },
      });
      session.conversationId = outcome.conversationId ?? session.conversationId;
      session.messages.push({ role: "user", content: prompt }, { role: "assistant", content: outcome.text });
    } catch (error) {
      session.conversationId = priorId;
      throw error;
    } finally {
      if (session.activeAbortController === controller) session.activeAbortController = undefined;
    }
  }

  describeModel(session: AgyStreamSession): string {
    return `agy-cli/${(session.model || "gemini-3.7-flash-high").replace(/^agy-cli\//, "")}`;
  }
}
