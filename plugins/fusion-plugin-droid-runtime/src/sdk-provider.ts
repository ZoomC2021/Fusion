/** Official Droid SDK bridge. Every tool executes in Fusion, never in Droid. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSession, ProcessTransport, AutonomyLevel, DroidInteractionMode, ReasoningEffort } from "@factory/droid-sdk/node";
import {
  AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { PiContext } from "./prompt-builder.js";
import { discoverDroidImageModels } from "./sdk-models.js";
import { buildSdkPrompt } from "./sdk-prompt.js";

const activeControllers = new Set<AbortController>();

export function killAllSdkSessions(): void {
  for (const controller of activeControllers) controller.abort(new Error("Droid runtime stopped."));
}

type Options = SimpleStreamOptions & { cwd?: string; binaryPath?: string; mcpConfigPath?: string };

// A schema-only process is a second boundary if the CLI runs ahead of its
// event consumer. It cannot perform a host action even before interruption.
const SCHEMA_SERVER = `const fs=require('node:fs');
const tools=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 let m;try{m=JSON.parse(line)}catch{return}
 if(m.id===undefined)return;
 let result;
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fusion',version:'1'}};
 else if(m.method==='tools/list')result={tools};
 else if(m.method==='tools/call')result={content:[{type:'text',text:'Tool execution belongs to Fusion.'}],isError:true};
 else if(m.method==='ping')result={};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown method'}})+'\\n');return}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;

function hostToolName(name: string, names: Set<string>, server: string): string | undefined {
  for (const prefix of [`${server}___`, `mcp__${server}__`]) {
    if (name.startsWith(prefix)) {
      const candidate = name.slice(prefix.length);
      if (names.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export function streamViaSdk(model: Model<Api>, context: PiContext, options: Options = {}): AssistantMessageEventStream {
  // @ts-expect-error pi-ai's export-star declarations hide this runtime constructor.
  const stream = new AssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant", api: "droid-cli", provider: model.provider, model: model.id,
    content: [], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    let directory: string | undefined;
    let transport: ProcessTransport | undefined;
    let session: Awaited<ReturnType<typeof createSession>> | undefined;
    const controller = new AbortController();
    activeControllers.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const configuredFirst = Number(process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS);
    const firstTimeout = Number.isSafeInteger(configuredFirst) && configuredFirst > 0 ? configuredFirst : 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function armTimeout(ms: number) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error("Droid SDK request timed out waiting for progress.")), ms);
      timer.unref();
    }
    armTimeout(firstTimeout);
    const abort = () => { void transport?.close().catch(() => {}); };
    let activeIndex = -1;
    function endBlock() {
      const block = output.content[activeIndex];
      if (block?.type === "text") stream.push({ type: "text_end", contentIndex: activeIndex, content: block.text, partial: output });
      if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: activeIndex, content: block.thinking, partial: output });
      activeIndex = -1;
    }
    try {
      signal?.throwIfAborted();
      const { prompt, images } = buildSdkPrompt(context);
      if (images.length) {
        const capable = await discoverDroidImageModels({ binaryPath: options.binaryPath, signal });
        signal.throwIfAborted();
        if (!capable.includes(model.id)) {
          throw new Error(`Droid model ${model.id} does not advertise image support; select an image-capable model explicitly.`);
        }
      }
      const tools = (context.tools ?? []).map((tool) => ({
        name: tool.name, description: tool.description ?? "",
        inputSchema: (tool as typeof tool & { parameters?: Record<string, unknown> }).parameters ?? { type: "object", properties: {} },
      }));
      const names = new Set(tools.map((tool) => tool.name));
      const server = `fusion-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      directory = mkdtempSync(join(tmpdir(), "fusion-droid-sdk-"));
      const schemaPath = join(directory, "tools.json");
      writeFileSync(schemaPath, JSON.stringify(tools), { mode: 0o600 });
      const cwd = options.cwd ?? process.cwd();
      transport = new ProcessTransport({ droidExecPath: options.binaryPath ?? "droid", cwd });
      signal?.addEventListener("abort", abort, { once: true });
      signal?.throwIfAborted();
      await transport.connect();
      signal?.throwIfAborted();
      session = await createSession({
        transport, cwd, modelId: model.id,
        reasoningEffort: options.reasoning === "minimal" || options.reasoning === "low" ? ReasoningEffort.Low
          : options.reasoning === "medium" ? ReasoningEffort.Medium
          : options.reasoning === "xhigh" ? ReasoningEffort.Max : ReasoningEffort.High,
        autonomyLevel: AutonomyLevel.Off, interactionMode: DroidInteractionMode.Auto, autoRejectPermissionRequests: true,
        disableBuiltinSkills: true, abortSignal: signal,
        systemPrompt: `${context.systemPrompt ?? ""}\nYou operate through Fusion. Request only the supplied MCP tools, then stop. Fusion executes them with its own permissions.`,
        mcpServers: tools.length ? [{ name: server, command: process.execPath, args: ["-e", SCHEMA_SERVER, schemaPath], env: {} }] : [],
      });
      signal?.throwIfAborted();
      const available = await session.listTools();
      signal?.throwIfAborted();
      const toolSettings = {
        restrictToolIds: available.filter((tool) => hostToolName(tool.id, names, server)).map((tool) => tool.id),
        disabledToolIds: available.filter((tool) => !hostToolName(tool.id, names, server)).map((tool) => tool.id),
      };
      if (toolSettings.restrictToolIds.length !== names.size) throw new Error("Droid did not expose every declared Fusion tool.");
      // Droid defers MCP schemas until its metadata-only ToolSearch loads them.
      // Permit that discovery helper, but never any native action tool.
      if (tools.length && available.some((tool) => tool.id === "ToolSearch")) {
        toolSettings.restrictToolIds.push("ToolSearch");
        toolSettings.disabledToolIds = toolSettings.disabledToolIds.filter((id) => id !== "ToolSearch");
      }
      await session.updateSettings(toolSettings);
      signal?.throwIfAborted();
      stream.push({ type: "start", partial: output });
      let completed = false;
      function usage(value: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }) {
        output.usage.input = value.inputTokens;
        output.usage.output = value.outputTokens;
        output.usage.cacheRead = value.cacheReadTokens ?? 0;
        output.usage.cacheWrite = value.cacheCreationTokens ?? 0;
        output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      }
      for await (const event of session.stream(prompt, { includePartialMessages: true, abortSignal: signal, ...(images.length ? { images } : {}) })) {
        signal?.throwIfAborted();
        armTimeout(30 * 60_000);
        if (event.type === "assistant_text_delta" || event.type === "thinking_text_delta") {
          const type = event.type === "assistant_text_delta" ? "text" : "thinking";
          if (output.content[activeIndex]?.type !== type) {
            endBlock();
            activeIndex = output.content.length;
            output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
            stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: activeIndex, partial: output });
          }
          const block = output.content[activeIndex];
          if (block.type === "text") block.text += event.text;
          if (block.type === "thinking") block.thinking += event.text;
          stream.push({ type: type === "text" ? "text_delta" : "thinking_delta", contentIndex: activeIndex, delta: event.text, partial: output });
        } else if (event.type === "tool_call") {
          if (tools.length && event.name === "ToolSearch") continue;
          const name = hostToolName(event.name, names, server);
          if (!name) throw new Error(`Droid requested an undeclared tool: ${event.name}`);
          await session.interrupt();
          signal?.throwIfAborted();
          endBlock();
          const toolCall = { type: "toolCall" as const, id: event.toolUseId || randomUUID(), name, arguments: event.input };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(event.input), partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
          output.stopReason = "toolUse";
          completed = true;
          break;
        } else if (event.type === "token_usage_update") usage(event);
        else if (event.type === "result") {
          if (!event.success) throw new Error(event.error?.message ?? `Droid turn failed: ${event.subtype}`);
          if (event.tokenUsage) usage(event.tokenUsage);
          completed = true;
        } else if (event.type === "error") throw new Error(event.message);
      }
      signal?.throwIfAborted();
      if (!completed) throw new Error("Droid stream ended without a successful result.");
      endBlock();
      stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
      stream.end(output);
    } catch (error) {
      endBlock();
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      const cause = signal.aborted ? signal.reason : error;
      output.errorMessage = cause instanceof Error ? cause.message : String(cause);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
      signal?.removeEventListener("abort", abort);
      // Closing transport first also releases SDK closeSession requests if the
      // CLI stopped answering during abort or a protocol failure.
      await transport?.close().catch(() => {});
      await session?.close().catch(() => {});
      if (directory) {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* Cleanup must not reject the completed stream. */ }
      }
    }
  })();
  return stream;
}
