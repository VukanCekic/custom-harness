# coding-harness (custom-harness)

## What
- A TypeScript coding agent: streaming tool loop, context compaction, plan/work/review subagent pipeline. Docs: `README.md`.
- Stack: Node >=20.3 (CI runs Node 24), TypeScript 7, ESM, tsx, oxlint.
- Current status: `HANDOFF.md`.

## Verify
- `npm run check` = `typecheck` (`tsc --noEmit`) + `lint` (`oxlint src tests`) + `test`. CI also runs `npm run build`.
- `npm test` = `tsx --test "tests/**/*.test.ts"`. Tests use `tests/helpers/mock.ts` (scripted mock LLM) and never touch the network.

## Rules
- Windows is the primary dev OS. The bash tool is Git Bash. `src/context.ts` canonicalises 8.3 short paths: keep it that way.
- Two backends: remote (OpenRouter, default) and local (`--local` or `LLM_BACKEND=local`). Never send OpenRouter-only fields (`provider`, cache breakpoints, `REASONING_ROUNDTRIP`) to a local server. Wire formats: `docs/local-backend-wire-format.md`.
- `.env` is gitignored and holds `OPENROUTER_API_KEY`. Never print it.
- `BYPASS_PERMISSIONS=true` auto-approves bash, writes and browser hosts. Never leave it set outside a throwaway checkout.
- Changing the system prompt (`src/config.ts`) or the tool schemas (`src/tools/`) invalidates the baselines in `D:\code\harness-finetune-lab`. Re-run `npm run eval:sync-tools` there.

## Where things live
- `src/agent.ts` loop, `src/llm.ts` + `src/openaiCompat.ts` backends, `src/config.ts` env settings and system prompt.
- `src/permissions.ts` + `src/execute.ts` the tool gate, `src/tools/` tools, `src/subagent.ts` + `src/pipeline.ts` subagents.
- `docs/` audits and plans. `docs/runs/2026-10-02-boids-pipeline-review.md` is gitignored.
- Consumers: `D:\code\harness-finetune-lab` (evals) and `D:\code\portfolio`. The portfolio's `harnessShowcase` numbers come from the gitignored boids run file above: keep it.

## Git
- Default branch `master`. Feature branch -> PR -> merge commit. Never squash.
- Tag `v1.0.0` = `f552961`, and `harness-finetune-lab` run files record harness commit hashes. Squashing orphans them.
