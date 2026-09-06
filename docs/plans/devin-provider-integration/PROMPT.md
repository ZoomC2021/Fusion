# Complete the local Devin provider integration

## Original Description

Verify and fix the reported Devin provider defects: broken resume recovery,
startup discovery, missing model fallback, missing Fusion tool bridge, dropped
activity events, unsafe session persistence, and missing provider controls.
Merge the completed changes into the fork's main branch.

## What This Delivers

Operators can use Devin to verify work and finish cards, see progress while it
works, safely resume independent conversations, and enable or disable it from
settings or onboarding without changing their existing sign-in.

## Before → After Transformation

Previously Devin returned text without access to Fusion tools, parallel lanes
rewrote a shared session map, and provider startup depended on CLI discovery.
The provider now registers immediately, hands custom tool calls to the normal
Fusion tool loop, displays native activity, locks each session independently,
and exposes installation/sign-in status with an enable switch.

## Surface Enumeration

- Shared pi provider registration: repeated loads, missing discovery, disabled
  cached providers, and static fallback rows.
- ACP: fresh/resumed sessions, expired sessions, workspace/model mismatches,
  initialization/prompt failures, load timeouts, cancellation, replayed history,
  custom verification/completion tools, and follow-up tool results.
- Native activity: text, thought, tool start/end, plan snapshots and experimental
  plan updates/removal. Native tool events must not cause a second execution.
- Persistence: concurrent distinct sessions, duplicate ownership, legacy input,
  malformed records, expiration, bounded history, and active-session retention.
- Dashboard: auth/status routes, explicit Off filtering, existing registry rows,
  settings and onboarding cards, missing binary, missing login, probe failure,
  and enable/disable actions. Both compact and full layouts reuse responsive
  provider primitives for desktop and mobile; no affordance is removed.
- Extension precedence: engine, CLI dashboard, and daemon registration use the
  same vendored-provider preference; explicit Off removes external copies too.

## Symptom Verification

- **Original symptom:** expired sessions returned `cwd is not defined`, discovery
  could make the provider disappear, tools were invisible, and working sessions
  appeared idle.
- **Exact reproduction:** simulate rejected ACP loads and real MCP tool requests;
  run the installed CLI with harmless mock verification and completion tools.
- **Assertion it is gone:** one fresh session recovers a rejected load with full
  context; a timed-out load or failed prompt never replays work; the live CLI
  yields verification then completion calls, receives results, and replies
  `SMOKE-OK`. Activity is emitted without duplicate native tool execution.

## External Integration Evidence

- Canonical upstream repo URL: not verified for the proprietary Devin CLI;
  `upstream-pending-verification`. Do not substitute an unrelated GitHub CLI.
- Docs / homepage URL: https://cli.devin.ai/reference/commands
- Release / download URL: https://cli.devin.ai/install.sh
- Binary / CLI name: `devin`
- Checksum: `upstream-pending-verification`
- Locally tested version: `devin 3000.6.14 (18033302)`.
- Compatibility finding: `session/new.mcpServers` advertises the server, but
  native MCP lookup requires a configured server. A temporary XDG config view
  merges the bridge entry without overwriting user/project configuration.

## File Scope

- packages/devin-cli/
- packages/core/src/plugins/pi-extensions.ts
- packages/core/src/types/settings/settings-scope.ts
- packages/core/src/config/settings-schema.ts
- packages/core/src/index.ts
- packages/core/src/index.gate.ts
- packages/core/src/__tests__/reconcile-devin-cli-paths.test.ts
- packages/engine/src/pi.ts
- packages/engine/src/agents/cli-provider-routing.ts
- packages/engine/src/__tests__/cli-provider-routing.test.ts
- packages/cli/src/commands/
- packages/dashboard/
- plugins/fusion-plugin-acp-runtime/package.json
- pnpm-lock.yaml
- docs/local-deployment.md
- .changeset/devin-cli-session-start.md
