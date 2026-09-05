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

## Fusion MCP bridge (slice 2 — pending)

When a session has Fusion `fn_*` custom tools, Fusion will start a token-protected loopback bridge and stage a per-session entry. That bridge is not implemented in this slice; a session with `options.fusionTools?.length` records `fusionToolBridgeError = { reasonCode: "bridge-start-failed" }` for now (mirroring how Cursor degrades), with a `// TODO(agy-mcp-bridge)` seam in `runtime-adapter.ts`.
