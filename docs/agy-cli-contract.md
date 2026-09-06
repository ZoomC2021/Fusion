# Antigravity CLI (`agy`) Runtime Contract

Date: 2026-09-06

Launch/readiness contract and failure taxonomy for
`fusion-plugin-agy-runtime`, which drives the
[Antigravity CLI](https://antigravity.google/docs/cli/overview) (`agy`) over its
stream-json transport. Mirrors the shape of `docs/cursor-cli-contract.md` and
`docs/acp-contract.md`.

## Purpose

The plugin registers provider `agy-cli` and runtime `agy` so Fusion can route
agent sessions to the Antigravity CLI binary. One supervised `agy` process runs
per prompt turn; the `conversation_id` from the `init` event is retained and
passed back with `--conversation` on the next turn to resume. Fusion never
touches agy's on-disk conversation databases; resume is handled entirely via
that flag.

## Install and auth

- **Official installer:**
  - macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
    (binary lands in `~/.local/bin/agy`).
  - Windows: `irm https://antigravity.google/cli/install.ps1 | iex`
    (binary lands in `%LOCALAPPDATA%\agy\bin`).
- `agy` self-updates via `agy update`; the installer manages its own provenance.
- **Sign in** by running `agy` once interactively. Tokens are stored in the
  OS keyring (macOS Keychain / Linux secret-service / Windows Credential
  Manager), **not** in a file. A headless Fusion daemon/worker runs in a
  different security session and may hit a locked or unavailable keyring —
  surfaced as a distinct auth failure (see below).
- Conversations persist as SQLite DBs under
  `~/.gemini/antigravity-cli/conversations/<id>.db`; Fusion never reads or
  writes those databases.

## Probe and auth contract

There is no `status` / `whoami` subcommand. The probe
(`plugins/fusion-plugin-agy-runtime/src/probe.ts`) infers readiness from two
commands:

1. `agy --version` — confirms the binary is callable (exit 0).
2. `agy models` — fetches the model catalog from the backend. An exit 0 with at
   least one model row means the stored keyring token is usable, so the probe
   reports `authenticated: true`.

Binary resolution tries the configured `agyCliBinaryPath` first, then `agy` on
PATH. The probe default timeout is 8s.

### Failure taxonomy

| State | Trigger |
| --- | --- |
| `available: true`, `authenticated: true` | `agy --version` exits 0 and `agy models` returns ≥1 model |
| `available: true`, `authenticated: false` (keyring locked) | `--version` or `models` stderr mentions `keyring` / `secret service` / `secret-service` |
| `available: true`, `authenticated: false` (not authenticated) | `agy models` exits nonzero or returns zero models without a keyring signal |
| `available: false` (binary missing) | `agy --version` spawn fails on every candidate (configured path + PATH fallback) |

A keyring/secret-service lock is distinguished from a plain unauthenticated
state so the operator gets an actionable reason ("OS keyring/secret-service is
locked or unavailable") rather than a generic auth failure.

## Model discovery

`agy models` writes a `Fetching available models...` notice to **stderr**, then
prints tab-separated `<id>\t<Label>` rows on **stdout** (no header line on
stdout). The parser (`process-manager.ts` `parseAgyModelLines`) splits on tab,
takes `[0]` as the id and `[1]` as the label (falling back to the id when no tab
is present), drops blank lines and the defensive fetching notice, and dedupes by
id. Discovered models are surfaced additively in `/api/models` under the
`agy-cli` provider when `agyCliEnabled` is on.

Model effort is encoded in the model id suffix (`-low` / `-medium` / `-high`),
so `--effort` is never passed separately. A leading `agy-cli/` prefix is
stripped from model ids before invocation; `describeModel` returns
`agy-cli/<model>`.

## Execution transport contract

Fusion runs one supervised
`agy --dangerously-skip-permissions --mode <accept-edits|plan> --model <id> [--conversation <id>] --input-format stream-json --output-format stream-json`
turn per prompt. The prompt is supplied on stdin as a single NDJSON
`{"event":"user","message":{"content":"<prompt>"}}` line, then stdin is closed;
the process `cwd` is the Fusion task worktree.

| Fusion tool mode | agy flags |
| --- | --- |
| `coding` | `--mode accept-edits` |
| `readonly` or unset | `--mode plan` |

`--dangerously-skip-permissions` is always passed because Fusion runs in an
isolated task worktree. Plan mode is the readonly posture.

### Stream-json events

`agy` stream-json emits one JSON object per line (verified against agy 1.1.27):

- `{"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","tools":[…]}}`
- `{"event":"step_update","step_update":{"conversation_id":"…","step_index":N,"state":"DONE|ACTIVE|ERROR","step_type":"user_input|agent_response|tool","text_delta":"…","tool_name":"…","tool_info":{"name":"…","parameters":{…},"output":"…","error":{…}},"usage":{…}}}`
- `{"event":"result","result":{"conversation_id":"…","status":"SUCCESS|ERROR","response":"…","error":"…","usage":{…}}}`

The `conversation_id` from the `init` event is retained and passed back with
`--conversation` on the next turn to resume. The `result` event is the terminal
event; `result.status` of anything other than `SUCCESS` is treated as an error.
`result.response` is the canonical full reply and is used as a fallback when no
`agent_response` `text_delta` was streamed. Reasoning is folded into
`usage.thinking_tokens`; there is no separate thinking text-delta event, so the
`onThinking` callback is wired but never fires today. Unknown stream lines
become a non-fatal `{ kind: "unknown" }` event so a partial CLI line cannot
crash the engine.

### Windows launch

The Windows prompt transport prefers a direct executable. `.cmd` / `.bat` shims
validate and reject cmd metacharacters before a quoted cmd launch; `.ps1` uses
PowerShell `-File`; unknown extensions fail loudly. `where.exe` resolves the
first directory's preferred extension so a `.cmd` shim does not shadow the real
executable.

## Resume and cancel semantics

agy has **no in-process cancel**. To cancel a turn, Fusion aborts the
`AbortSignal`, which kills the subprocess (SIGKILL on POSIX, `taskkill /T /F`
tree on Windows). The prior `conversationId` is retained across the kill so the
next turn resumes the same conversation — the partial turn's output is lost, but
the conversation history is preserved. On a turn error the
`conversationId` is restored to the pre-turn value so a failed turn cannot
corrupt the resume token.

The system prompt is fused into the first turn only; subsequent turns send the
bare user prompt.

## Timeouts and env knobs

An agy turn is bounded by first-output and reset-on-output inactivity, **not** a
total duration. The supervisor lifetime cap is disabled because active coding
turns may legitimately stream beyond two minutes.

| Env var | Default | Purpose |
| --- | --- | --- |
| `PI_AGY_CLI_FIRST_LINE_TIMEOUT_MS` | `60000` | Cold-start guard: time to first stream line. Gemini 3.7 Flash cold-starts in ~5–8s plus thinking before the first token, so the default is generous. |
| `PI_AGY_CLI_TIMEOUT_MS` | `120000` | Inactivity guard: reset on every stream line. |

## Settings keys

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `agyCliEnabled` | `boolean` | `undefined` | Enables the `agy-cli` provider in model pickers after Antigravity CLI status validation. Toggle from Settings → Authentication. Run `agy` once to authenticate. |
| `agyCliBinaryPath` | `string` | `undefined` | Optional global, machine-local `agy` executable override used by probes, status/enable validation, and model discovery. Leave unset/blank to auto-detect `agy` on PATH. Use this when PATH points at the wrong install or Windows exposes a specific `.cmd` / `.bat` shim. |

## Fusion MCP bridge (fn_* tools)

> **Status: deferred.** `fn_*` custom tools are **not available** to agy
> sessions today. A session with Fusion `fn_*` custom tools records
> `fusionToolBridgeError = { reasonCode: "bridge-start-failed" }` (the same
> code Cursor uses, so the engine surfaces it consistently) and the turn still
> runs tool-less. The `FNXC:AgyMcpBridge 2026-09-06` block in
> `runtime-adapter.ts` documents the deferral in-place. The session types
> (`toolBridge`, `mcpLease`, `mcpServerKey`) remain declared so a future bridge
> worker can populate them without changing `types.ts`.

agy 1.1.27 does not load workspace plugin MCP servers
(`.agents/plugins/<name>/mcp_config.json`) in
`--input-format stream-json --output-format stream-json` (print) mode — the
only transport Fusion uses. The machine-wide global config
(`~/.gemini/config/mcp_config.json`) is the only MCP path that loads in print
mode, but writing it would leak Fusion `fn_*` tools across all agy sessions and
operators on the host, so it is rejected. Config-redirect experiments
(`XDG_CONFIG_HOME`, `HOME` override with symlinked `antigravity-cli`,
`ANTIGRAVITY_EXECUTABLE_DATA_DIR`, `--add-dir`, `--new-project`,
`AGY_CLI_NEW_HARNESS`) all failed to load a per-session MCP config with working
auth. See
[`docs/solutions/integration-issues/agy-mcp-print-mode-discovery.md`](./solutions/integration-issues/agy-mcp-print-mode-discovery.md)
for the full experiment matrix and the re-test procedure for newer agy
releases.

When agy gains per-session MCP support in print/stream-json mode, the bridge
can proceed using the `call_mcp_tool` event shape captured in
`plugins/fusion-plugin-agy-runtime/src/__tests__/fixtures/agy-mcp-tool-call.stream.jsonl`:
agy invokes MCP tools through the built-in `call_mcp_tool` tool with
`parameters.ToolName` carrying the `fn_*` name and `parameters.ServerName`
carrying the configured server name — not a namespaced tool name like Cursor.
A future `tool-mapping` layer must extract `parameters.ToolName` and match
`parameters.ServerName` to the session `serverKey`.

## Known limitations

- **Cold-start latency:** Gemini 3.7 Flash cold-starts in ~5–8s plus thinking
  before the first token. The first-line timeout default (60s) accommodates
  this, but operators on slow networks may still need to raise
  `PI_AGY_CLI_FIRST_LINE_TIMEOUT_MS`.
- **`--dangerously-skip-permissions` always on:** Fusion runs agy in an isolated
  task worktree, so the permissions gate is always skipped. Plan mode
  (`--mode plan`) is the readonly posture; `accept-edits` is the coding posture.
- **No in-process cancel:** kill-to-cancel means a cancelled turn's partial
  output is lost (the conversation is preserved).
- **Keyring auth in headless daemons:** tokens live in the OS keyring, so a
  detached Fusion daemon/worker may hit a locked or unavailable keyring. This
  surfaces as a distinct auth failure rather than a generic error.
- **No thinking stream:** reasoning is folded into `usage.thinking_tokens`;
  `onThinking` is wired but never fires today.
- **Staged, not auto-installed:** `fusion-plugin-agy-runtime` is in the staged
  bundled-plugin set (`packages/cli/src/plugins/staged-bundled-plugin-ids.ts`)
  for explicit install via `fn plugin install fusion-plugin-agy-runtime`, not
  in the default auto-install subset (`BUNDLED_PLUGIN_IDS`).

## External Integration Evidence

- Canonical upstream repo URL: https://github.com/google-antigravity/antigravity-cli
- Docs / homepage URL: https://antigravity.google/docs/cli/overview
- Release / download URL: https://antigravity.google/cli/install.sh (and the
  PowerShell installer `https://antigravity.google/cli/install.ps1`)
- Binary / CLI name: `agy`
- Checksum: `upstream-pending-verification` (installer-managed, self-updating
  via `agy update`; local provenance `1.1.27` verified 2026-09-06)
