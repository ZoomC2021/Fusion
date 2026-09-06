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
FNXC:AgyMcpBridge 2026-09-06:
The fn_* tool bridge is deferred: agy 1.1.27 does not load workspace plugin
MCP servers in print/stream-json mode, and the machine-wide global config is
rejected for cross-session isolation. These loose types remain intentionally
declared so a future bridge worker (when agy gains per-session MCP support)
can populate them without changing this file. See
docs/solutions/integration-issues/agy-mcp-print-mode-discovery.md.
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
