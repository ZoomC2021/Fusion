# Local Deployment — This Checkout Is a Live Fork

**Audience:** agents and operators working in this clone (`~/Repos/Fusion`).
This checkout is not a scratch clone: a systemd user service runs the board
from it right now. Follow this doc whenever you pull, merge, or rebuild.

## What is local-only here

Upstream `Runfusion/Fusion` does not have the local-integration work. `main`
carries (find them with `git log --oneline upstream/main..main`):

- `packages/devin-cli/` — vendored Devin CLI provider (free GLM/SWE models,
  ACP over `devin acp --model <id>`, session resume, usage tracking).
  Registration is synchronous with three fallback free-model rows and no CLI
  discovery spawn. `discoverDevinModels` remains an explicit discovery helper.
  Rejected session loads recover once with full context; prompt failures and
  load timeouts are not replayed. Workspace/model mismatches start fresh.
  Fusion custom tools now return through pi's normal tool loop; native Devin
  tool, thought, and plan activity streams into the dashboard. Per-session
  atomic files and heartbeat locks replace shared-map writes; records expire
  after 30 days and unlocked history is capped at 1,000 entries.
  Settings → Authentication and onboarding expose Devin status and an enable
  switch. Undefined `useDevinCli` preserves the fork's existing On default;
  explicit Off hides models and refuses new turns, including cached providers.
  Devin 3000.6.14 requires an isolated MCP config view in addition to ACP
  `mcpServers`. The provider creates and removes that view per tool-bearing turn;
  it never overwrites the user's or project's MCP configuration.
- `plugins/fusion-plugin-agy-runtime/` — Antigravity native stream runtime and
  dashboard provider surface, merged from the fork's remote main. Native-only
  text sessions and Linux Fusion/custom MCP calls are live-tested. Tool-bearing
  turns require `/usr/bin/bwrap` and an existing global MCP config; a private
  read-only mount substitutes the per-turn config without editing host settings.
- `plugins/fusion-plugin-droid-runtime/src/sdk-provider.ts` — official SDK
  transport replaces obsolete print flags. Fusion owns tool execution; only
  Droid's metadata-only ToolSearch helper may run internally. The provider
  currently accepts text input. Live text and host tool interception are tested.
- `packages/cli/package.json` — workspace deps for `@fusion/devin-cli`,
  `@fusion/droid-cli`, and `@fusion-plugin-examples/droid-runtime`. Without
  them `resolveVendoredDevinCliEntry` / `resolveVendoredDroidCliEntry`
  return null in a source checkout and those providers vanish from the
  engine's model registry (cards fail with "was not found in the pi model
  registry" even though the picker shows them via the route merge).
- `packages/droid-cli/index.ts` — registers a **static placeholder model
  catalog** at boot instead of an empty list (see the FNXC comment in the
  default export). Zero `droid` spawns; the registry's provider-template
  fallback then accepts any droid model id.
- `packages/engine/src/pi.ts`, `packages/dashboard/src/routes/register-model-routes.ts`,
  `packages/engine/src/auth/provider-auth.ts` — devin-cli wiring (extension
  loading, `/api/models` allow-list, CLI provider id set).
- `fork-desktop.sh` — desktop launcher that attaches the Electron shell to
  the running service (external-cli mode) instead of starting a second
  engine.

Settings, credentials, and the devin session map live outside the repo in
`~/.fusion/` and survive rebuilds.

## Runtime topology

- **Engine + dashboard:** systemd user unit `~/.config/systemd/user/fusion.service`
  runs `node packages/cli/dist/bin.js dashboard -p 4321` with
  `FUSION_DASHBOARD_TOKEN=diagtok123`, `WorkingDirectory=/var/home/zoomcharts/Repos/agent-tools`.
  Control: `systemctl --user {status,restart,stop} fusion.service`; logs via
  `journalctl --user -u fusion.service`.
- **Desktop:** the `Fusion` desktop entry runs `fork-desktop.sh`, which sets
  `FUSION_SERVER_PORT=4321` and launches Electron on
  `packages/cli/dist/desktop/main.js`. In external-cli mode the shell attaches
  to the service — it must never start its own embedded runtime, or two
  engines race the same board. First launch (or after a token change) the
  renderer asks for the dashboard token once and stores it.
- **Brew fallback:** the brew install (`0.77.0`, `brew pin`ned, Cellar
  patches from the pre-fork era) is dormant. Do not `brew upgrade fusion`,
  do not launch `/home/linuxbrew/.linuxbrew/bin/fusion desktop`, and do not
  run brew fusion instances while the service runs.
- Board URL: `http://localhost:4321/?token=diagtok123` (localhost-only).

## Update procedure

```bash
cd ~/Repos/Fusion

# 1. Integrate upstream. Preserve the local commits above; expect conflicts
#    in the files listed in "What is local-only here".
git fetch upstream && git merge upstream/main   # or rebase — operator's call

# 2. Install (packageManager pins pnpm 10.33.0; pnpm auto-switches).
pnpm install

# 3. Electron postinstall is blocked by pnpm's build-script gate; the dist/
#    directory ends up partial (often just `locales/`) and Electron fails
#    with "Cannot find module .../electron" or "path.txt" errors. Extract
#    the cached zips manually:
for pair in \
  "33.4.11:4b092cc678b6ff8448c5ab35fabca1710dccc91cfbff065280601a184126b0fe" \
  "35.7.5:f71d58b9535ad2f1d90f09dd91a30fea648c4fe7e710e38a47d6983edd09e53f"; do
  p=${pair%%:*}; sha=${pair##*:}
  d=node_modules/.pnpm/electron@$p/node_modules/electron
  rm -rf "$d/dist" && mkdir -p "$d/dist"
  unzip -q ~/.cache/electron/$sha/electron-v$p-linux-x64.zip -d "$d/dist"
  printf electron > "$d/path.txt"
done
#    (new Electron versions: check packages/cli + packages/desktop pins and
#    the sha-keyed dirs under ~/.cache/electron; a missing zip means one
#    `node install.js` run inside the package dir to fetch it once.)

# 4. Full build. Fast mode (`pnpm build` without the flag) SKIPS bundled
#    plugin staging and desktop assets — the board boots but runtimes
#    (droid/acp/claude) degrade. Always ship the full build:
FUSION_CLI_FULL_PACKAGE=1 pnpm build

# 5. Restart the service so the new dist is live:
systemctl --user restart fusion.service
```

Never run releases/`pnpm release`/publishes from task lanes — operator-only
(see AGENTS.md). Do not push to any remote without the operator asking.

## Post-update verification

1. `systemctl --user is-active fusion.service` → active; no ERROR lines in
   `journalctl --user -u fusion.service -n 100`.
2. `curl -s http://127.0.0.1:4321/api/health -H "Authorization: Bearer diagtok123"`
   → `status: ok`, engine available, database healthy.
3. Model catalog sane
   (`curl -s http://127.0.0.1:4321/api/models -H "Authorization: Bearer diagtok123"`):
   devin-cli 3 (`glm-5-2`, `swe-1-7`, `swe-1-7-medium`), droid-cli ≥ 50,
   openrouter ~428, openai-codex 8, cursor-cli ~211. Anthropic rows appear
   only while its OAuth credential is valid (they vanish on expiry —
   re-login in the dashboard; do not confuse this with a build regression).
4. Extension loads clean: no "Failed to load ...-cli/index.ts" or
   "Cannot find module '@fusion-plugin-examples/droid-runtime'" in the log.
5. Smoke task end-to-end (proves lane validation + CLI execution):
   create a task with description "Write the exact text SMOKE-OK to the file
   /tmp/fusion-smoke.txt then finish." via the UI or
   `POST /api/tasks` (bearer token), let it plan and execute, then check the
   file. A droid-cli fallback lane exercises the droid path; the executor
   lane is devin-cli/glm-5-2.

## Troubleshooting quick reference

- **"was not found in the pi model registry" for droid-cli/devin-cli** → the
  vendored extension didn't load. Check the workspace deps in
  `packages/cli/package.json` and the droid static catalog patch.
- **Electron "failed to install correctly" / spawn ENOENT** → re-extract the
  zips (step 3). A `path.txt` written with a trailing newline breaks spawn —
  use `printf`, never `echo`.
- **Desktop starts a second engine** → the launcher must export
  `FUSION_SERVER_PORT`; check `fork-desktop.sh`.
- **Auth dialog on desktop** → paste the current `FUSION_DASHBOARD_TOKEN`.
- **Port conflicts** → port 4040 is reserved repo-wide; the board uses 4321.

## Devin provider regression coverage

### Surface Enumeration

- The shared provider factory used by all pi lanes: repeated registration and
  explicit discovery failure must leave a usable catalog without startup spawns.
- ACP sessions: absent and legacy entries, matching sessions, workspace/model
  mismatches, rejected loads, load timeouts, initialize/prompt failures, and a
  failed replacement. Replayed history must not enter the new assistant output.
- Routing: primary and fallback Devin selections remain registry-based.
- No UI affordances changed; desktop and mobile use the same server provider.
  Both settings and onboarding expose the same enable/status behavior and
  reuse the existing responsive provider-card primitives.

### Symptom Verification

- **Original symptom:** an expired ACP session returned `Error: cwd is not defined`;
  every provider load ran discovery and failed discovery left zero model rows.
- **Exact reproduction:** the provider test supplies a saved matching session,
  rejects `session/load`, and inspects the fresh prompt and saved replacement.
  Separate cases repeat registration and reject explicit discovery.
- **Assertion it is gone:** the replacement returns `completed` with full context,
  registration performs zero spawns with nonempty models, and failed prompts or
  load timeouts never start replacement work.

Run `pnpm --filter @fusion/devin-cli test` and
`pnpm --filter @fusion/devin-cli typecheck`. The package typecheck is included by
root `pnpm typecheck`; tests use an in-memory ACP peer without live AI calls.

Live smoke on Devin 3000.6.14 with `glm-5-2` completed three turns:
`fn_run_verification` → successful mock tool result → `fn_task_done` → successful
mock tool result → `SMOKE-OK`. No real board card or verification command was
mutated by this integration smoke.
