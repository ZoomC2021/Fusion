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

import type { ToolLike } from "@fusion-plugin-examples/acp-runtime/tool-bridge";
export type { ToolLike } from "@fusion-plugin-examples/acp-runtime/tool-bridge";

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
  hostTools?: ToolLike[];
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
