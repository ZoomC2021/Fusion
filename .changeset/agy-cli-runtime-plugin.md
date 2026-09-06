---
"@runfusion/fusion": minor
---

summary: Add Antigravity CLI (agy) as a bundled runtime provider with Gemini model discovery and resumable sessions.
category: feature
dev: New staged plugin `fusion-plugin-agy-runtime` (`runtimeId` agy, provider `agy-cli`); settings `agyCliEnabled`/`agyCliBinaryPath`; stream-json transport with `--conversation` resume; fn_* tool bridge deferred (agy 1.1.27 print mode only loads the machine-wide MCP config); sessions with fusionTools set bridge-start-failed and run tool-less.
