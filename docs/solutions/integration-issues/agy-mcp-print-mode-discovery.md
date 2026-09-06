---
title: "agy 1.1.27 does not load workspace plugin MCP servers in print/stream-json mode — fn_* tool bridge deferred"
date: 2026-09-06
category: integration-issues
module: fusion-plugin-agy-runtime
problem_type: integration_issue
component: tooling
symptoms:
  - "A Fusion agy session with fn_* custom tools records fusionToolBridgeError = { reasonCode: \"bridge-start-failed\" } and runs the turn tool-less"
  - "agy plugin validate accepts a workspace plugin (.agents/plugins/<name>/mcp_config.json) but a print/stream-json turn never registers its MCP server"
  - "init.tools lists call_mcp_tool but no fn_* tool; the agent reports the MCP server unavailable"
  - "--log-file shows declarative_config_loader.go: skipping component … empty component: prompt section \"mcp_servers\""
root_cause: upstream_feature_gap
resolution_type: deferred
severity: high
tags: [agy, antigravity-cli, mcp, workspace-plugin, print-mode, stream-json, fn-tools, runtime-plugin]
related_components: [tooling, model-runtime]
---

# agy 1.1.27 does not load workspace plugin MCP servers in print/stream-json mode

## Problem

The Fusion `fn_*` tool bridge for `fusion-plugin-agy-runtime` was designed to
stage a per-session workspace plugin lease under
`.agents/plugins/fusion-custom-tools-<uuid>/` in the task worktree, so agy
would discover the plugin's `mcp_config.json` and route `call_mcp_tool` calls
back to Fusion's `fn_*` tools over a token-protected loopback bridge (mirroring
the Cursor runtime's `.cursor/mcp.json` lease pattern).

**agy 1.1.27 does not load workspace plugin MCP servers in
`--input-format stream-json --output-format stream-json` (print) mode** — the
only transport Fusion uses. The per-session workspace-plugin lease design
cannot work on this agy version. The machine-wide global config
(`~/.gemini/config/mcp_config.json`) is the only MCP path that loads in print
mode, but the orchestrator rejected it because it would leak Fusion `fn_*`
tools across all agy sessions and operators on the host.

## Investigation (real agy 1.1.27 binary)

All runs used `agy --dangerously-skip-permissions --mode accept-edits|plan
--model gemini-3.7-flash-low --input-format stream-json --output-format
stream-json` from a scratch git repo under `/tmp`, with a trivial stdio MCP
server exposing `fn_echo`.

### Workspace plugin under `.agents/plugins/test/` — NOT loaded

- `plugin.json` = `{"name":"test"}`, `mcp_config.json` declared the stdio
  server, `agy plugin validate .agents/plugins/test` reported `[ok]` with
  `mcpServers: 1 processed`.
- Print/stream-json turn: `init.tools` lists `call_mcp_tool` but NOT `fn_echo`
  or any namespaced variant. The agent responded that `call_mcp_tool` / the
  `test` MCP server is "not available in the current environment".
- `--log-file` showed no plugin-discovery log lines and
  `declarative_config_loader.go: skipping component during resolution: empty
  component: prompt section "mcp_servers"`.
- `agy plugin list` => "No imported plugins." `agy mcp list` => "No MCP
  servers configured." `agy plugin enable test` => `plugin "test" not found
  or invalid`.
- Also tried `.agents/plugins.json` with `entries:[{path:".agents/plugins"}]`
  and a `.gemini/plugins/test2/` variant — neither loaded.

### `agy plugin install` (global import) — still NOT loaded in print mode

- Copied the plugin into `~/.gemini/config/plugins/test/` and recorded it in
  `import_manifest.json`; `agy plugin list` then showed the import.
- Print/stream-json turn still did NOT load the MCP server: `init.tools`
  unchanged, agent reported `fn_echo` unavailable, `mcp_servers` log line
  still "empty component".

### Global MCP server via `agy mcp add` — DOES load in print mode

- `agy mcp add testecho node <path>/echo-server.cjs` wrote
  `~/.gemini/config/mcp_config.json` (`mcpServers.testecho`).
- Print/stream-json turn: the agent called `call_mcp_tool` with
  `ServerName:"testecho", ToolName:"fn_echo", Arguments:{message:"ping"}` and
  received `output:"ECHO:ping"`.
- This confirms print/stream-json mode loads ONLY global `mcp_config.json`
  servers, not workspace plugin servers. (Diagnostic only — cleaned up
  afterward; never used as the bridge implementation.)

### Config-redirect experiments — all failed

| Experiment | Per-session? | Auth works? | MCP loaded? |
| --- | --- | --- | --- |
| `XDG_CONFIG_HOME=<scratch>` with `gemini/config/mcp_config.json` | yes | yes | **no** |
| `XDG_CONFIG_HOME=<scratch>` with `.gemini/config/mcp_config.json` | yes | yes | **no** |
| `HOME=<scratch>` + symlinked `antigravity-cli` + scratch `mcp_config.json` | yes | yes (models fetched) | **no** |
| `ANTIGRAVITY_EXECUTABLE_DATA_DIR=<scratch>` with `config/mcp_config.json` | yes | yes | **no** |
| `--add-dir <dir>` with `.agents/plugins/test/` | yes | yes | **no** |
| `--new-project` | yes | yes | **no** |
| `--enable-plugins` flag | — | — | **not a valid flag** |
| `AGY_CLI_NEW_HARNESS=1` env | yes | yes | **no** |
| `--prompt-interactive` (TTY mode) | no | yes | **no MCP/plugin log lines** |

Binary symbol search: `override_mcp_config_json` / `mcp_config_json` are
server-side proto fields (`McpSetting`), not CLI flags or env vars. No
`AGY_*` / `ANTIGRAVITY_*` / `GEMINI_*` env name maps to an MCP config
override. `headless_customizations.go` exists in the binary but produces no
plugin/MCP discovery log lines in any mode tested.

### Cleanup

All diagnostic global config changes (`testecho` server, `test` plugin) were
removed with `agy mcp remove testecho` and `agy plugin uninstall test`;
`~/.gemini/config/mcp_config.json` was restored to `{"mcpServers":{}}`.
Scratch repos under `/tmp` were deleted. The real `~/.gemini` state was
verified byte-identical to the pre-experiment baseline.

## Captured MCP tool-call event shape

agy invokes MCP tools through the built-in `call_mcp_tool` tool, NOT by
namespacing the tool name. The `fn_*` name lives in `parameters.ToolName`:

```json
{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"message":"ping"},"ServerName":"testecho","ToolName":"fn_echo"}}}}
{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool","duration_seconds":0.011,"tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"message":"ping"},"ServerName":"testecho","ToolName":"fn_echo"},"output":"ECHO:ping"}}}
```

Implications for any future bridge (if agy gains workspace-plugin support):
- `tool-mapping` must extract `parameters.ToolName` (and match
  `parameters.ServerName` to the session `serverKey`), not strip a prefix
  from `tool_name` as Cursor does.
- `stream-parser` already parses `step_type:"tool"` ACTIVE/DONE/ERROR into
  tool-call-started/completed events; the `call_mcp_tool` shape needs no new
  event kind, only that the mapping layer read `args.ToolName`.

## Resolution: deferred

The bridge is intentionally not implemented. A session with Fusion custom
tools records `fusionToolBridgeError = { reasonCode: "bridge-start-failed" }`
(the same code Cursor uses, so the engine surfaces it consistently) and the
turn still runs tool-less. The `FNXC:AgyMcpBridge 2026-09-06` block in
`runtime-adapter.ts` documents the deferral in-place.

## Re-test procedure for newer agy releases

When a newer agy version is available, re-run this experiment to check
whether workspace plugin MCP discovery has been added to print/stream-json
mode:

```bash
# 1. Create a scratch git repo
ROOT=$(mktemp -d /tmp/agy-retest-XXXXXX); cd "$ROOT"
git init -q; git config user.email t@e.invalid; git config user.name test
echo seed > README.md; git add .; git commit -qm seed

# 2. Create a trivial stdio MCP server exposing fn_echo
cat > echo-server.cjs <<'EOF'
#!/usr/bin/env node
"use strict";
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0.0"}}})+"\n"); return; }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{tools:[{name:"fn_echo",description:"echo",inputSchema:{type:"object",properties:{message:{type:"string"}},required:["message"]}}]}})+"\n"); return; }
  if (msg.method === "tools/call") { const a=msg.params?.arguments??{}; process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{content:[{type:"text",text:"ECHO:"+String(a.message??"")}],isError:false}})+"\n"); return; }
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Method not found: "+msg.method}})+"\n");
});
EOF

# 3. Stage a workspace plugin
mkdir -p .agents/plugins/test
echo '{"name":"test"}' > .agents/plugins/test/plugin.json
cat > .agents/plugins/test/mcp_config.json <<EOF
{"mcpServers":{"test":{"command":"node","args":["$ROOT/echo-server.cjs"]}}}
EOF

# 4. Validate the plugin
agy plugin validate .agents/plugins/test

# 5. Run a print/stream-json turn asking the agent to call fn_echo
PROMPT='Use call_mcp_tool to call fn_echo on the test server with message "ping". Report the exact result.'
PAYLOAD=$(printf '{"event":"user","message":{"content":%s}}' "$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")
echo "$PAYLOAD" | agy --dangerously-skip-permissions --mode accept-edits --model gemini-3.7-flash-low --input-format stream-json --output-format stream-json --log-file /tmp/agy-retest.log

# 6. Check: did init.tools include fn_echo or did the agent successfully call
#    call_mcp_tool with ToolName=fn_echo and get ECHO:ping?
#    If yes, workspace plugin MCP discovery works — proceed to implement the bridge.
#    If no (agent reports the server unavailable), the gap persists — keep the deferral.

# 7. Clean up
cd /; rm -rf "$ROOT" /tmp/agy-retest.log
```

## Fixtures

- `plugins/fusion-plugin-agy-runtime/src/__tests__/fixtures/agy-mcp-tool-call.stream.jsonl`
  — positive: global MCP server, agent calls `call_mcp_tool` → `fn_echo`,
  returns `ECHO:ping`. Used by `stream-parser.test.ts` to future-proof the
  parser against the `call_mcp_tool` event shape.
