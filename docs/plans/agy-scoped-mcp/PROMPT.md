# Scoped Antigravity host tools

## Original Description
Resolve the remaining Antigravity host-tool limitation without modifying global MCP settings.

## What This Delivers
Antigravity can call Fusion verification and completion tools on supported Linux hosts.

## Before → After Transformation
Tool-bearing turns refused → isolated per-turn MCP configuration with authenticated host calls.

## File Scope
- plugins/fusion-plugin-agy-runtime/
- pnpm-lock.yaml
- docs/agy-cli-contract.md
- docs/local-deployment.md
- docs/solutions/integration-issues/agy-mcp-print-mode-discovery.md
- .changeset/agy-scoped-mcp.md (new)

## Surface Enumeration
Native-only versus host-tool turns; fusionTools and customTools; new and resumed
sessions; parallel sessions; Linux support versus missing bwrap/config/namespaces;
caller cancellation, disposal, setup failures, transport failures, and successful
cleanup. Both coding and readonly native postures retain their flags.

## Symptom Verification
- Original symptom: required Fusion tools could not be called in agy stream mode.
- Exact reproduction: real adapter turn asks fn_scoped_echo to return an unpredictable host-side marker; automated tests exercise mount argv, parallel config isolation, cancellation, and terminal cleanup.
- Assertion it is gone: host closure runs and its result reaches the final response, while host config bytes remain unchanged and owned per-turn files are removed.

## External Integration Evidence
- Canonical upstream repo URL: https://github.com/google-antigravity/antigravity-cli
- Docs / homepage URL: https://antigravity.google/docs/cli/overview
- Release / download URL: https://antigravity.google/cli/install.sh
- Binary / CLI name: `agy`
- Checksum: upstream-pending-verification
- Canonical upstream repo URL: https://github.com/containers/bubblewrap
- Docs / homepage URL: https://github.com/containers/bubblewrap/blob/main/README.md
- Release / download URL: https://github.com/containers/bubblewrap/releases
- Binary / CLI name: `bwrap`
- Checksum: upstream-pending-verification
