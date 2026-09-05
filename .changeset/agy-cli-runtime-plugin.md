---
"@runfusion/fusion": minor
---

summary: Add Antigravity CLI (agy) as a bundled runtime provider with Gemini model discovery and resumable sessions.
category: feature
dev: New staged plugin `fusion-plugin-agy-runtime` (`runtimeId` agy, provider `agy-cli`); settings `agyCliEnabled`/`agyCliBinaryPath`; stream-json transport with `--conversation` resume; fn_* tools bridged via `.agents/plugins/fusion-custom-tools-*` lease.
