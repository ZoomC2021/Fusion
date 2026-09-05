export type AgyStreamEvent =
  | { kind: "system-init"; conversationId?: string; cwd?: string; model?: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-call-started" | "tool-call-completed"; name: string; args?: Record<string, unknown>; result?: unknown; isError: boolean }
  | { kind: "result"; conversationId?: string; text?: string; error?: string; isError: boolean; usage?: unknown }
  | { kind: "unknown" };

/*
FNXC:AgyCli 2026-09-06-00:00:
agy stream-json emits one JSON object per line. Verified shapes (agy 1.1.27):
  {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","tools":[…]}}
  {"event":"step_update","step_update":{"conversation_id":"…","step_index":N,"state":"DONE|ACTIVE|ERROR","step_type":"user_input|agent_response|tool","text_delta":"…","tool_name":"…","tool_info":{"name":"…","parameters":{…},"output":"…","error":{…}},"usage":{…}}}
  {"event":"result","result":{"conversation_id":"…","status":"SUCCESS|ERROR","response":"…","error":"…","usage":{…}}}
Reasoning is folded into usage.thinking_tokens; there is no separate thinking
text-delta event, so no thinking-delta kind is emitted today. Unknown lines
become a non-fatal { kind: "unknown" } so a partial CLI line cannot crash the engine.
*/
export function parseAgyStreamLine(line: string): AgyStreamEvent {
  if (!line.trim()) return { kind: "unknown" };
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return { kind: "unknown" };
    value = parsed as Record<string, unknown>;
  } catch { return { kind: "unknown" }; }

  const event = value.event;

  if (event === "init") {
    const init = value.init as Record<string, unknown> | undefined;
    return {
      kind: "system-init",
      conversationId: typeof value.conversation_id === "string" ? value.conversation_id : undefined,
      cwd: typeof init?.cwd === "string" ? init.cwd : undefined,
      model: typeof init?.model === "string" ? init.model : undefined,
    };
  }

  if (event === "step_update") {
    const step = value.step_update as Record<string, unknown> | undefined;
    if (!step) return { kind: "unknown" };
    const stepType = step.step_type;
    const state = step.state;
    const conversationId = typeof step.conversation_id === "string" ? step.conversation_id : undefined;

    if (stepType === "agent_response" && typeof step.text_delta === "string") {
      return { kind: "assistant-text", text: step.text_delta };
    }

    if (stepType === "tool" && (state === "ACTIVE" || state === "DONE" || state === "ERROR")) {
      const toolInfo = step.tool_info as Record<string, unknown> | undefined;
      const name = typeof step.tool_name === "string" ? step.tool_name : typeof toolInfo?.name === "string" ? toolInfo.name : "unknown";
      const args = toolInfo?.parameters && typeof toolInfo.parameters === "object" ? toolInfo.parameters as Record<string, unknown> : undefined;
      if (state === "ACTIVE") {
        return { kind: "tool-call-started", name, args, isError: false };
      }
      const isError = state === "ERROR";
      const result = isError ? toolInfo?.error : toolInfo?.output;
      return { kind: "tool-call-completed", name, args, result, isError };
    }

    // user_input and text-less agent_response steps carry no Fusion-relevant payload.
    return { kind: "unknown" };
  }

  if (event === "result") {
    const result = value.result as Record<string, unknown> | undefined;
    if (!result) return { kind: "unknown" };
    const status = result.status;
    const isError = status !== "SUCCESS";
    return {
      kind: "result",
      conversationId: typeof result.conversation_id === "string" ? result.conversation_id : undefined,
      text: typeof result.response === "string" ? result.response : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
      isError,
      usage: result.usage,
    };
  }

  return { kind: "unknown" };
}
