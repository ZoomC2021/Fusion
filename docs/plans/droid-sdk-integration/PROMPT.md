# Restore Droid execution through its supported SDK

## Original Description

Audit Devin, Droid and Antigravity integrations in Fusion, codex-router and agent skills; fix issues, commit, push and deploy.

## What This Delivers

Droid requests run through the supported automation interface, report failures accurately, and hand tool calls back to Fusion. Concurrent requests cannot overwrite each other's instructions.

## Before → After Transformation

Fusion passed obsolete print-mode options that the installed Droid interpreted as an interactive prompt. The provider now uses the official SDK, configures the requested model and tools explicitly, and waits for a terminal result or intercepted host tool call. The runtime adapter consumes the real asynchronous event stream, preserves conversation history and working directory, and supports cancellation. Its host loop executes only supplied, already-gated custom tools; the default registry-based Droid provider receives Fusion’s full gated coding/read-only toolset.

## External Integration Evidence

- Canonical upstream repo URL: https://github.com/Factory-AI/droid-sdk-typescript
- Docs / homepage URL: https://docs.factory.ai/sdk/typescript
- Release / download URL: https://www.npmjs.com/package/@factory/droid-sdk/v/0.9.1
- Binary / CLI name: `droid`; Node dependency: `@factory/droid-sdk` version `0.9.1`
- Checksum: dependency integrity is pinned in `pnpm-lock.yaml`; CLI binary is `upstream-pending-verification`.

## File Scope

- `plugins/fusion-plugin-droid-runtime/`
- `packages/droid-cli/`
- `pnpm-lock.yaml`
- `.changeset/droid-sdk-execution.md` (new)
- `docs/plans/droid-sdk-integration/PROMPT.md` (new)

## Surface Enumeration

- pi extension and package provider shim both use the SDK provider; the standalone runtime adapter uses the same provider and forwards workspace, configured binary and reasoning.
- Fresh requests, continued Fusion transcript, explicit empty tools, supplied custom tools, fallback registered tools, unknown tool names, native tools and schema-only tool interception.
- Normal text/thinking/usage, failed or missing terminal results, pre-abort, mid-turn abort, initialization failure, watchdog expiry and disposal.
- Concurrent requests use independent temporary schema directories and transport sessions; no shared system-prompt file remains.
- Image input is explicitly unsupported in the new bridge and rejected rather than silently dropped; catalog capabilities advertise text input.
- No UI affordance changes. Desktop and mobile share the provider backend.
- Python Droid skill driver and codex-router are separate integrations and have separate regression suites.

## Symptom Verification

- **Original symptom:** the installed Droid 0.213.0 treats `-p --input-format stream-json` as interactive prompt text; cancellation can hang or errors become successful stops; runtime callbacks subscribe to an EventEmitter API that the pi stream does not expose.
- **Exact reproduction:** verify installed CLI help and a bounded old-protocol launch, then exercise the official SDK with an isolated text request and schema-only tool. Unit tests inject missing results, failures and cancellation; runtime tests use a real pi asynchronous stream.
- **Assertion it is gone:** successful requests terminate with the expected text, supplied tools are returned for Fusion execution, failures carry error/aborted status, cancellation releases transport resources, and the runtime receives deltas and settles.

## Verification

Run both Droid package suites, typecheck/build, lint, the thin merge gate and boot smoke. Run a harmless live text/tool interception test with the selected Droid Core model. No package publishing or version tagging is part of this deployment.

Live validation on Droid 0.213.0 / GLM-5.3-Flash returned `SDK_OK` and intercepted `smoke_echo({value: "SDK_OK"})` without executing a host action. MCP identities stay below Droid’s 32-character truncation boundary; the native `ToolSearch` metadata helper is permitted for deferred schemas while all action tools remain disabled.
