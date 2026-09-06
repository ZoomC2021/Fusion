# fusion-plugin-agy-runtime

Antigravity CLI (`agy`) backed provider/runtime plugin for Fusion.

## Contract summary

- Provider ID: `agy-cli`
- Binary probes: configured `agyCliBinaryPath` first, then `agy` on PATH
- Expected failure states: missing binary, OS keyring locked / secret-service unavailable, unauthenticated runtime (no models fetched)
- Model discovery: `agy models` prints tab-separated `<id>\t<Label>` rows on stdout (the `Fetching available models...` notice is written to stderr). Parse into `{ id, label }`, drop blank/header lines, dedupe by id.
- Auth status: there is no `status`/`whoami` subcommand. Authentication is inferred from whether `agy models` exits 0 and yields at least one model within the timeout (it fetches from the backend). Fail closed to `authenticated:false` with an actionable `reason` on nonzero exit / empty output / timeout. A keyring/secret-service lock is surfaced as a distinct reason when stderr mentions it.

## Notes

`agy` stores tokens in the OS keyring and persists conversations as SQLite DBs under `~/.gemini/antigravity-cli/conversations/<id>.db`. Fusion never touches those databases; resume is handled entirely via the `--conversation <id>` flag.

## External Integration Evidence

- Canonical upstream repo URL: https://github.com/google-antigravity/antigravity-cli
- Docs / homepage URL: https://antigravity.google/docs/cli/overview
- Release / download URL: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (installs `~/.local/bin/agy`); Windows `irm https://antigravity.google/cli/install.ps1 | iex`
- Binary / CLI name: `agy`
- Checksum: `upstream-pending-verification` (installer-managed, self-updates via `agy update`; verified local provenance `1.1.27` on 2026-09-06)

## Execution transport contract

Fusion runs one supervised `agy --dangerously-skip-permissions --input-format stream-json --output-format stream-json` turn per prompt. The prompt is supplied on stdin as a single NDJSON `{"event":"user","message":{"content":"<prompt>"}}` line, then stdin is closed; the process `cwd` is the Fusion task worktree. Stream JSON emits `init`, `step_update` (user_input / agent_response / tool), and terminal `result` events; the `conversation_id` from the `init` event is retained and passed back with `--conversation <id>` on the next turn to resume.

| Fusion tool mode | agy flags |
| --- | --- |
| `coding` | `--mode accept-edits` |
| `readonly` or unset | `--mode plan` |

`--dangerously-skip-permissions` is always passed because Fusion runs in an isolated task worktree. The model effort is encoded in the model id suffix (`-low`/`-medium`/`-high`), so `--effort` is never also passed. A leading `agy-cli/` prefix is stripped from model ids before invocation; `describeModel` returns `agy-cli/<model>`.

agy folds reasoning into `usage.thinking_tokens` and emits no separate thinking text-delta event, so the `onThinking` callback is wired but never fires today. Unknown stream lines become a non-fatal `{ kind: "unknown" }` event.

All turns use `superviseSpawn` with a disabled total lifetime cap (active coding turns may legitimately stream beyond two minutes). The Windows prompt transport prefers a direct executable; `.cmd`/`.bat` shims validate and reject cmd metacharacters before a quoted cmd launch, `.ps1` uses PowerShell `-File`, and unknown extensions fail loudly. `PI_AGY_CLI_FIRST_LINE_TIMEOUT_MS` (default 60000) and `PI_AGY_CLI_TIMEOUT_MS` (default 120000) optionally tune cold-start and inactivity guards; agy has no in-process cancel, so an `AbortSignal` kills the subprocess (SIGKILL on POSIX, taskkill tree on Windows) while the prior `conversationId` is retained so the next turn resumes.

## Fusion MCP bridge (fn_* tools) — deferred

`fn_*` custom tools are **not available** to agy sessions today. agy 1.1.27
does not load workspace plugin MCP servers (`.agents/plugins/<name>/mcp_config.json`)
in `--input-format stream-json --output-format stream-json` (print) mode — the
only transport Fusion uses. The machine-wide global config
(`~/.gemini/config/mcp_config.json`) is the only MCP path that loads in print
mode, but writing it would leak Fusion `fn_*` tools across all agy sessions and
operators on the host, so it is rejected.

A session with `options.fusionTools?.length` records
`fusionToolBridgeError = { reasonCode: "bridge-start-failed" }` (the same code
Cursor uses, so the engine surfaces it consistently) and the turn still runs
tool-less. The `FNXC:AgyMcpBridge 2026-09-06` block in `runtime-adapter.ts`
documents the deferral in-place. The session types (`toolBridge`, `mcpLease`,
`mcpServerKey`) remain declared so a future bridge worker can populate them
without changing `types.ts`.

See `docs/solutions/integration-issues/agy-mcp-print-mode-discovery.md` for the
full experiment matrix and the re-test procedure for newer agy releases. When
agy gains per-session MCP support in print/stream-json mode, the bridge can
proceed using the `call_mcp_tool` event shape captured in
`src/__tests__/fixtures/agy-mcp-tool-call.stream.jsonl` (agy invokes MCP tools
through the built-in `call_mcp_tool` tool with `parameters.ToolName` carrying
the `fn_*` name — not a namespaced tool name like Cursor).
