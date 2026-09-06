import { streamViaSdk as streamViaCli } from "./sdk-provider.js";
import { resolveCliSettings } from "./cli-spawn.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, DroidSession } from "./types.js";

export class DroidRuntimeAdapter implements AgentRuntime {
  readonly id = "droid";
  readonly name = "Droid Runtime";
  private readonly settings: ReturnType<typeof resolveCliSettings>;

  constructor(settings?: Record<string, unknown>) {
    this.settings = resolveCliSettings(settings);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const model = this.settings.model ?? options.defaultModelId ?? "glm-5.3-flash";
    const subscribers = new Set<(event: unknown) => void>();
    const session: DroidSession = {
      model, systemPrompt: options.systemPrompt, cwd: options.cwd, messages: [], apiKey: undefined,
      thinkingLevel: options.defaultThinkingLevel, sessionId: "", lastModelDescription: `droid/${model}`,
      // Engine supplies already-gated closures. Never reconstruct these tools or
      // enable native Droid equivalents, which would bypass Fusion permissions.
      tools: options.customTools ?? [],
      callbacks: { onText: options.onText, onThinking: options.onThinking, onToolStart: options.onToolStart, onToolEnd: options.onToolEnd },
      subscribe: handler => { subscribers.add(handler); return () => { subscribers.delete(handler); }; },
      emit: event => { for (const handler of subscribers) { try { handler(event); } catch { /* observers cannot break execution */ } } },
      dispose: () => { session.activeController?.abort(); subscribers.clear(); },
    };
    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
    const model = { id: String(session.model ?? this.settings.model ?? "glm-5.3-flash"), provider: "droid-cli", api: "droid-cli" } as any;
    if (session.activeController) throw new Error("Droid session already has an active turn");
    const controller = new AbortController();
    session.activeController = controller;
    const outerSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      session.messages.push({ role: "user", content: prompt });
      while (true) {
        signal.throwIfAborted();
        const stream = streamViaCli(model, {
          messages: session.messages, systemPrompt: session.systemPrompt,
          tools: session.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        } as any, { cwd: session.cwd, binaryPath: this.settings.binaryPath, signal, reasoning: session.thinkingLevel } as any);
        let terminal: { reason: string; message: { content: Array<any> } } | undefined;
        for await (const event of stream) {
          signal.throwIfAborted();
          if (event.type === "text_delta") session.callbacks.onText?.(event.delta);
          else if (event.type === "thinking_delta") session.callbacks.onThinking?.(event.delta);
          session.emit({ type: "message_update", assistantMessageEvent: event });
          if (event.type === "error") throw new Error(event.error.errorMessage || "Droid request failed");
          if (event.type === "done") terminal = event;
        }
        signal.throwIfAborted();
        if (!terminal) throw new Error("Droid stream ended without a terminal result");
        session.messages.push(terminal.message);
        session.emit({ type: "message_end", message: terminal.message });
        if (terminal.reason !== "toolUse") return;
        const calls = terminal.message.content.filter(part => part.type === "toolCall");
        if (!calls.length) throw new Error("Droid requested tool execution without a tool call");
        for (const call of calls) {
          signal.throwIfAborted();
          const tool = session.tools.find(candidate => candidate.name === call.name);
          if (!tool) throw new Error(`Droid requested an undeclared host tool: ${call.name}`);
          session.callbacks.onToolStart?.(call.name, call.arguments);
          session.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
          let result: unknown, isError = false;
          try {
            result = await tool.execute(call.id, call.arguments, signal);
            isError = Boolean((result as { isError?: boolean } | null)?.isError);
          } catch (error) {
            signal.throwIfAborted();
            isError = true;
            result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
          }
          signal.throwIfAborted();
          session.callbacks.onToolEnd?.(call.name, isError, result);
          session.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, isError, result });
          session.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: (result as { content?: unknown } | null)?.content ?? [{ type: "text", text: JSON.stringify(result) ?? "" }], isError, timestamp: Date.now() });
        }
      }
    } finally { session.activeController = undefined; }
  }

  async dispose(session: AgentSession): Promise<void> { session.dispose(); }
  describeModel(session: AgentSession): string { return session.lastModelDescription || "droid"; }
}
