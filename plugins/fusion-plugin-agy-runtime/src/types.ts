export interface AgyBinaryStatus {
  available: boolean;
  authenticated?: boolean;
  binaryPath?: string;
  binaryName?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  diagnostics?: string[];
  version?: string;
  reason?: string;
  probeDurationMs: number;
}

/*
FNXC:AgyCli 2026-09-06-00:00:
The fn_* tool bridge is added in slice 2 by a separate worker. These loose
types are intentionally declared here so runtime-adapter.ts can carry the
session fields the bridge will populate without importing a not-yet-created
tool-bridge.ts. The bridge worker may narrow/replace them.
*/
export interface ToolLike {
  name: string;
  execute?: (...args: unknown[]) => unknown;
}

export interface AgyToolBridge {
  dispose: () => Promise<void>;
  serverEntry: unknown;
}

export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  defaultModelId?: string;
  skills?: string[];
  skillSelection?: unknown;
  customTools?: ToolLike[];
  fusionTools?: ToolLike[];
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
}

export interface AgyStreamSession {
  model: string;
  mode: "accept-edits" | "plan";
  cwd: string;
  tools?: "coding" | "readonly";
  messages: unknown[];
  state: { messages: unknown[] };
  conversationId: string;
  callbacks: Pick<AgentRuntimeOptions, "onText" | "onThinking" | "onToolStart" | "onToolEnd">;
  fusedSystemPrompt: string;
  disposed: boolean;
  activeAbortController?: AbortController;
  toolBridge?: AgyToolBridge;
  mcpLease?: { dispose: () => Promise<void>; heartbeat: () => Promise<unknown> };
  mcpHeartbeatTimer?: ReturnType<typeof setInterval>;
  mcpServerKey?: string;
  fusionToolBridgeError?: { reasonCode: "bridge-start-failed" };
  dispose: () => void | Promise<void>;
}

export interface AgentSessionResult {
  session: AgyStreamSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgyStreamSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgyStreamSession): string;
}
