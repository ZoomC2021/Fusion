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

    /*
    FNXC:AgyMcpBridge 2026-09-06:
    The fn_* tool bridge is intentionally NOT implemented. agy 1.1.27 does not
    load workspace plugin MCP servers (`.agents/plugins/<name>/mcp_config.json`)
    in `--input-format stream-json --output-format stream-json` (print) mode —
    the only transport Fusion uses. Verified against the real 1.1.27 binary:
    `agy plugin validate` accepts the plugin, but a print/stream-json turn
    never registers its MCP server (`init.tools` lists `call_mcp_tool` but no
    `fn_*` tool; the agent reports the server unavailable; `--log-file` shows
    `declarative_config_loader.go: skipping component … empty component: prompt
    section "mcp_servers"`). The only MCP path that loads in print mode is the
    machine-wide `~/.gemini/config/mcp_config.json`, which the orchestrator
    rejected because it would leak Fusion `fn_*` tools across all agy sessions
    and operators on the host. Redirect experiments (XDG_CONFIG_HOME, HOME
    override with symlinked antigravity-cli, ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    --add-dir, --new-project, --enable-plugins, AGY_CLI_NEW_HARNESS) all failed
    to load a per-session MCP config with working auth. See
    docs/solutions/integration-issues/agy-mcp-print-mode-discovery.md for the
    full experiment matrix and the re-test procedure for newer agy releases.

    A session with Fusion custom tools therefore records
    `fusionToolBridgeError = { reasonCode: "bridge-start-failed" }` (the same
    code Cursor uses) so the engine surfaces it consistently, and the turn
    still runs tool-less. The session types (`toolBridge`, `mcpLease`,
    `mcpServerKey`) remain declared so a future bridge worker can populate them
    without changing types.ts.
    */
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
        // FNXC:AgyCli 2026-09-06-00:00: forward every delta verbatim; the transport already guards result.response double-emit via its !output check, so a content-keyed Set here would wrongly drop repeated identical deltas (e.g. two "\n").
        onText: (text) => session.callbacks.onText?.(text),
      });
      session.conversationId = outcome.conversationId || session.conversationId;
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
