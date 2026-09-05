# agy 1.1.27 MCP discovery findings (2026-09-06)

Investigation for the Fusion `fn_*` tool bridge into agy sessions via a
per-session workspace plugin lease (`.agents/plugins/fusion-custom-tools-<uuid>/`).

## Summary

**Workspace plugin MCP servers are NOT loaded by agy 1.1.27 in
`--print`/`--input-format stream-json --output-format stream-json` mode.**
The per-session workspace-plugin lease design from the task brief cannot work
on this agy version, because agy never reads `.agents/plugins/<name>/mcp_config.json`
during a print/stream-json turn. Per the task brief, the global config
(`~/.gemini/config/mcp_config.json`) is off-limits, so there is no supported
way to bridge `fn_*` tools into an agy print/stream-json session on 1.1.27.

## What was exercised (real agy 1.1.27 binary)

All runs used `agy --dangerously-skip-permissions --mode accept-edits|plan
--model gemini-3.7-flash-low --input-format stream-json --output-format
stream-json` from a scratch git repo, with a trivial stdio MCP server
exposing `fn_echo`.

### 1. Workspace plugin under `.agents/plugins/test/` — NOT loaded

- `plugin.json` = `{"name":"test"}`, `mcp_config.json` declared the stdio
  server, `agy plugin validate .agents/plugins/test` reported
  `[ok]` with `mcpServers : 1 processed`.
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

### 2. `agy plugin install .agents/plugins/test` (global import) — still NOT loaded in print mode

- Copied the plugin into `~/.gemini/config/plugins/test/` and recorded it in
  `import_manifest.json`; `agy plugin list` then showed the import.
- Print/stream-json turn still did NOT load the MCP server: `init.tools`
  unchanged, agent reported `fn_echo` unavailable, `mcp_servers` log line
  still "empty component".

### 3. Global MCP server via `agy mcp add` — DOES load in print mode

- `agy mcp add testecho node <path>/echo-server.cjs` wrote
  `~/.gemini/config/mcp_config.json` (`mcpServers.testecho`).
- Print/stream-json turn: the agent called `call_mcp_tool` with
  `ServerName:"testecho", ToolName:"fn_echo", Arguments:{message:"ping"}` and
  received `output:"ECHO:ping"`. See
  `agy-mcp-tool-call.stream.jsonl` (positive fixture).
- This confirms print/stream-json mode loads ONLY global `mcp_config.json`
  servers, not workspace plugin servers.

### Cleanup

The diagnostic global MCP server (`testecho`) and imported plugin (`test`)
were removed with `agy mcp remove testecho` and `agy plugin uninstall test`;
`~/.gemini/config/mcp_config.json` was restored to `{"mcpServers":{}}`.
Scratch repos under `/tmp` were deleted.

## Captured MCP tool-call event shape (from the global-server run)

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

## Fixtures

- `agy-mcp-tool-call.stream.jsonl` — positive: global MCP server, agent calls
  `call_mcp_tool` -> `fn_echo`, returns `ECHO:ping`.
- `agy-workspace-plugin-not-loaded.stream.jsonl` — negative: workspace plugin
  present and `plugin validate`-d, but agy reports no MCP server available.
