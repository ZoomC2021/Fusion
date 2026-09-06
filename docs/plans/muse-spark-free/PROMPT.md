# Enable Muse Spark Contributor Free in Fusion

## Original Description
Enable Muse Spark 1.3 Contributor Free from the existing OpenCode route in Fusion.

## What This Delivers
Fusion operators can select the free Muse Spark model and complete tasks with host tools.

## Before → After Transformation
A successful model reply followed by a proxy error lost its host tool call. A terminal Responses event now completes the SDK reader before trailing events can overwrite that outcome.

## File Scope
- patches/@earendil-works__pi-ai@0.84.4.patch (new)
- pnpm-workspace.yaml
- pnpm-lock.yaml
- docs/local-deployment.md
- packages/engine/src/__tests__/openai-responses-terminal.test.ts (new)
- .changeset/responses-terminal-authority.md (new)

## Surface Enumeration
The shared Responses parser serves OpenAI, Azure, and Codex-compatible transports.
Cover tool calls, completed replies, token-limit outcomes, failures before terminal,
and streams missing a terminal event. The model configuration uses the existing
Fusion models.json mechanism and the local authenticated codex-router route.

## Symptom Verification
- Original symptom: a trailing LiteLLM error overwrote response.completed, so pi dropped the assistant tool call on replay and upstream rejected its orphaned tool result.
- Exact reproduction: fixture SSE emits a completed tool call and response.completed, then a proxy error. Live Fusion registry performs a tool-call/result round trip through Muse Spark.
- Assertion it is gone: stopReason remains toolUse, usage is retained, tool result reaches a successful subsequent model response. Early failures still fail.
