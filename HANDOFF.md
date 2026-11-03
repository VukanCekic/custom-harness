## 2026-11-03 — Local OpenAI-compatible backend and eval support are pushed on the feature branch, not merged
**Done**
- Local OpenAI-compatible backend (`--local`, LM Studio / llama-server / Ollama) plus the harness-side support for the eval runner (exit codes, pinned sampling, thinking switch, wire log) is pushed on `feat/openai-compatible-provider` (`e694374`). The branch is 2 commits ahead of `origin/master`; it is not merged.
- 88/88 tests passed today via `npm test`.
- Local `master` was fast-forwarded to `origin/master` (`e4bc448`); it was 17 behind.

**Unverified**
- Typecheck, lint and build were not run locally today.
- The GitHub CI result for the branch was not checked.
- The branch is not merged. It is also 3 commits behind `origin/master` (the merge commits of PRs #1-#3); whether a PR needs a master merge first was not checked.
- `BYPASS_PERMISSIONS` is set in the local `.env` today (auto-approves bash, writes and browser).

**Next**
1. Open a PR `feat/openai-compatible-provider` -> `master`, merge commit (never squash).
2. Delete the merged remote branches `audit-implementation`, `audit-v2-fixes`, `dev`. Needs user approval.
3. Unset `BYPASS_PERMISSIONS` in `.env` unless sandboxed.
