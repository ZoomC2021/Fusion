# Droid Runtime Plugin

First-class Droid runtime/provider plugin (`@fusion-plugin-examples/droid-runtime`).

## Purpose

This package is the canonical home for Droid-specific runtime behavior, including:
- provider id `droid-cli`
- model discovery + normalization
- official Droid SDK subprocess streaming with complete Fusion transcript per turn
- MCP tool bridge + thinking effort mapping
- probe contract via `probeDroidBinary`

## Runtime + Provider

- Runtime ID: `droid`
- Display name: `Droid Runtime`
- Provider surface preserved: `Factory AI — via Droid CLI` (`droid-cli`)

Core implementation files live in `src/`:
- `runtime-adapter.ts`
- `provider.ts` (compatibility export)
- `sdk-provider.ts` (official SDK transport and host tool handoff)
- `process-manager.ts`
- `probe.ts`
- prompt/tool/thinking/control helpers

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS` | `120000` | Startup / first SDK-event deadline for Droid requests. Blank, non-numeric, zero, or negative values fall back to the default. |

The first-event guard is separate from the 30-minute inactivity safety net that applies after SDK events begin.

The SDK reuses the official CLI sign-in through `ProcessTransport`. Each request has its own schema-only MCP server and explicitly restricted host tools; Fusion executes intercepted calls. Missing tools or terminal results are errors. The provider accepts text input; images are rejected explicitly. The standalone adapter preserves workspace/history and consumes pi async stream events, executing only supplied, already-gated host tools. Normal coding/readonly lanes use the registry provider and Fusion’s complete gated toolset. The native `ToolSearch` metadata helper may load deferred schemas; no native action tools are enabled.

The former `droid -p` transport and `droid auth status` probe are removed because current Droid versions interpret those unsupported forms as interactive prompts. See https://docs.factory.ai/sdk/typescript for the supported protocol.

## Dashboard UI contribution surfaces

The plugin registers `uiSlots` for:
- `settings-provider-card`
- `settings-integration-card`
- `onboarding-provider-card`
- `onboarding-setup-help`
- `post-onboarding-recommendation`

## Compatibility with `@fusion/droid-cli`

`packages/droid-cli` is now a thin compatibility shim. It keeps the historical pi-extension entrypoint, but delegates runtime/provider behavior to this plugin package.
