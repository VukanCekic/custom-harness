# Custom Harness

A Node.js + TypeScript coding agent built on `@openrouter/sdk`. It streams answers, runs tools in an autonomous loop, keeps its context window under control without going blind, and can hand big jobs to a planner → worker → reviewer pipeline of isolated subagents. Every request is accounted for: tokens, cache hits, latency and cost, split by who spent it.

The design and its fail-safe guarantees come from the audit in [`docs/codebase_audit_and_proposals.md`](docs/codebase_audit_and_proposals.md). All three of its phases are implemented; see [Audit status](#audit-status).

## Running the agent

Requires Node.js 20.3 or later (CI runs Node 24).

1. **Install**:
   ```bash
   npm install
   ```

2. **Set your API key** in [`.env`](.env):
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

3. **Interactive session**:
   ```bash
   npm run dev
   ```

4. **One prompt from the command line**:
   ```bash
   npm run dev -- "List all TypeScript files in the src directory."
   ```

5. **Resume the last session of this project**:
   ```bash
   npm run dev -- --resume
   ```

6. **Start in pipeline mode** (the agent only coordinates subagents):
   ```bash
   npm run dev -- --pipeline "Add a health-check endpoint with tests"
   ```

Other flags: `--debug` shows raw responses, every late injection and every prompt-cache break; `--no-stream` prints answers only once they are complete.

### Commands and keys

| Command | What it does |
|---|---|
| `/help` | List commands |
| `/clear` (`/new`, `/reset`) | Start a new session: history, todos, plans and browser approvals cleared, browser closed |
| `/compact` | Summarise the conversation now, even if it is still short |
| `/rewind` | Go back to before one of your earlier messages (files on disk are not touched) |
| `/sessions` | Switch to an earlier session of this project |
| `/pipeline [on\|off]` | Toggle pipeline mode |
| `/exit` (`/quit`) | Quit |

- **Enter** on an empty line does nothing; it no longer ends the session.
- End a line with `\` to continue on the next. Pasted multi-line text is kept together. ↑/↓ browse input history, which persists per project.
- **Ctrl+C** during a turn cancels the turn, not the process. Pending tool calls get a `[cancelled by user]` result, so the transcript stays valid, and running shell commands are killed. A second Ctrl+C quits through a cleanup handler that removes temp files and closes the browser.
- **Ctrl+D**, or Ctrl+C twice at the prompt, quits.

## Configuration

All settings are environment variables (`.env` works too).

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required |
| `MODEL` | `deepseek/deepseek-v4.1-flash` | Any OpenRouter model id. `anthropic/*` models get explicit cache breakpoints |
| `PROVIDER_ONLY` | unset | Comma-separated provider list with fallbacks off, e.g. `together`. Unset = OpenRouter's default routing |
| `CONTEXT_WINDOW` | `64000` | Token budget the harness manages to |
| `COMPACT_AT` / `COMPACT_TO` | `0.85` / `0.35` | Compact when a request passes this share of the window; keep this share verbatim |
| `STRIP_AFTER` | `0.25` | Only shrink finished turns once the transcript passes this share of the window (below it, stripping costs more cache than it saves) |
| `TOOL_CAP` / `TOOL_STUB` | `10000` / `300` | Characters kept of a fresh / a finished tool result |
| `MAX_STEPS` | `60` | Steps per turn before the agent stops and asks you to say "continue" |
| `SUBAGENT_MAX_TURNS` | `15` | Research subagent turn limit (planner 10, worker 20, reviewer 8) |
| `SUBAGENT_TIMEOUT_MS` | `600000` | Wall-clock limit per subagent run |
| `MAX_REWORK` | `2` | Rework cycles allowed per plan after a `changes_requested` review |
| `STALL_MS` | `90000` | A stream with no data for this long is treated as dead |
| `REASONING_ROUNDTRIP` | `1` | Send providers' reasoning details back during tool loops (`0` to disable) |
| `BROWSER_ALLOW_HOSTS` | `localhost,127.0.0.1,[::1]` | Hosts the browser may open without asking |
| `BASH_PATH` | auto | Path to Git for Windows' `bash.exe`. Without it, the shell on Windows is PowerShell 5.1 and the tool description says so |
| `SESSION_DIR` | `~/.agents/sessions/<project>` | Where session logs and run records go |
| `SCRUB_ENV` | unset | Extra environment variables to hide from shell commands (the API key always is) |
| `HEADLESS`, `CHROME_PATH` | — | Browser launch options |
| `SYSTEM_PROMPT` | built in | Replace the system prompt |

At start-up the harness warns if `CONTEXT_WINDOW` leaves too little room after the tool schemas and system prompt.

## How it works

### The agent loop ([`src/agent.ts`](src/agent.ts))

Each step:

1. **Compact first**, if the request would pass `COMPACT_AT` and the transcript has grown by at least a quarter of the window since the last compaction. Compaction summarises what it removes, so it runs before anything is dropped. A failed compaction is reported and the turn carries on.
2. **Fit**, the last resort. It prices the deepest possible cut before making any. If even that cannot reach the budget it changes nothing and stops the turn with a `ContextBudgetError` that names the numbers. Otherwise it stubs results the model has already read, elides the bulky arguments of calls that already ran, drops read results, and only then squeezes unread results to a pointer at their full text on disk. A result the model has not read is never replaced by nothing.
3. **Late injection**: a small `<env>`/`<todos>`/file-changes block is appended to the request but never stored, so the stored prefix stays byte-identical and cached.
4. **Call the model**, streaming. Tool calls run through the shared gate (below). The fresh results are capped, keeping head and tail, with the full text spilled to a temp file.
5. At the end of the turn, if the transcript is big enough for it to pay, old tool results shrink to stubs and finished `write_file`/`str_replace` arguments are elided.

The turn ends when the model stops calling tools, after `MAX_STEPS`, or on Ctrl+C.

### One gate for every caller ([`src/execute.ts`](src/execute.ts), [`src/permissions.ts`](src/permissions.ts))

The main loop and every subagent execute tool calls through the same function. It rejects arguments that are not valid JSON (nothing runs), resolves the tool, applies the permission rules, and turns every failure into a result the model can read.

- **Rules.** Shell commands are split on real separators, quote- and shell-aware, and each part is rated `allow` or `ask`. Redirects, `$(…)`, backticks, process substitution, multi-line commands, credential paths and risky flags (`find -delete`, `git branch -D`, `sort -o`, …) escalate a command to `ask`. File tools ask outside the project or on credential files.
- **Browser.** `eval` always asks. `open` asks for any host not on `BROWSER_ALLOW_HOSTS`; approving a host allows it for the rest of the session.
- **Subagents.** A subagent asks the same human through async context. Read-only roles (planner, researcher) cannot ask at all, so anything that would need approval is refused. In pipeline mode the main agent's own `bash` is read-only too.
- **Sandbox** ([`src/sandbox.ts`](src/sandbox.ts)). `sandbox-exec` on macOS, `bwrap` on Linux when installed: the project is writable, its `.git` is not, and there is no network. Windows reports `none`. Paths are resolved through symlinks and junctions. The API key is removed from the environment of every command.

### Tools ([`src/tools/`](src/tools/))

| Tool | Notes |
|---|---|
| `bash` | Git Bash on Windows when available, otherwise PowerShell (stated in the tool description). Non-zero exits come back as `[exit code N]` |
| `read_file` | Line-numbered, paginated (`offset`/`limit`); refuses binaries and files over 2 MB unless paged |
| `grep`, `glob` | Pure Node, the same on every OS, respect `.gitignore`, skip binaries |
| `write_file`, `str_replace` | `mkdir -p`; literal replacement (no `$&` surprises); LF edits match CRLF files |
| `write_todos` | The plan, validated, with exactly one task in progress; re-injected every step |
| `ask_user` | A clarifying question mid-turn (main agent only) |
| `task` | Research subagent: own context, read-only, under-150-word findings |
| `plan_task`, `work_task`, `review_task` | The pipeline, below |
| `read_skill` | Skills from `.agents/skills/` and `~/.agents/skills/` |
| `browser` | `browserclaw` automation (snapshot + ref targeting), gated as above |

### Subagents and the pipeline ([`src/subagent.ts`](src/subagent.ts), [`src/tools/orchestrator.ts`](src/tools/orchestrator.ts), [`src/pipeline.ts`](src/pipeline.ts))

A subagent starts with exactly two messages, sees only the tools on its role's allowlist, fits its own context every turn, and keeps its own temp files. Only its final report comes back. Out of turns, out of time, cancelled or crashed, it still reports what it found plus `git status --short` of what it changed. Its tool calls are shown nested, followed by a line with its calls, tokens, cache share and cost.

The pipeline:

1. **`plan_task`**: a read-only planner writes the plan. It is saved to `.agents/artifacts/plan-<id>.md` (that folder ignores itself in git), and the main agent gets a `plan_id`. Plans are never pasted back into tool arguments.
2. **`work_task {plan_id}`**: the worker gets the stored plan. Before its first run the harness snapshots the working tree, untracked files included, in a throwaway git index.
3. **`review_task {plan_id}`**: the reviewer gets a diff from that snapshot to now, so files the worker created are visible. It must finish by calling `submit_review {verdict, summary, issues[]}`. The result's first line is the verdict, and no submission counts as `changes_requested`.
4. After `changes_requested`, the next `work_task` passes the reviewer's issues to the worker automatically. After `MAX_REWORK` cycles `work_task` refuses and tells the agent to report the open issues to you.

Calling `plan_task` switches the main agent to pipeline mode for the rest of the turn: it keeps only the coordination tools and read-only `bash`. `/pipeline on` makes that the session's mode.

### Prompt caching ([`src/cache.ts`](src/cache.ts), [`src/llm.ts`](src/llm.ts))

- Every request's stable prefix is hashed message by message. When it diverges from the previous request, the harness records where and why: strip, compaction, fit, mode switch, rewind, or a changed tool set. `--debug` prints it, and the run record keeps it.
- The end-of-turn summary shows the main loop's cache-hit percentage.
- For `anthropic/*` models, breakpoints go on the tool schemas, the system prompt, the end of the compacted prefix, and the newest stable message.

### Compaction ([`src/compact.ts`](src/compact.ts))

A summariser writes a handoff note (goal, what happened, files, state, next step). What you typed is not summarised. Every request is pinned verbatim in `<request>` blocks that carry through every later compaction, so a summary of a summary cannot paraphrase a constraint away. An earlier note is labelled as one, not as `USER:`. The note's text is inserted literally (no `$` expansion).

### Provider robustness ([`src/llm.ts`](src/llm.ts))

- 429 and 5xx errors are retried with bounded backoff (180 s; `Retry-After` honoured). A stalled stream is aborted after `STALL_MS`.
- Mid-stream provider errors are raised instead of passing off a truncated answer as complete.
- Cancels and subagent deadlines are never retried as if they were network errors.
- Every call is recorded in a ledger by role (main, planner, worker, reviewer, researcher, compaction), so reported cost includes subagents and compaction.

### Sessions and run records ([`src/session.ts`](src/session.ts), [`src/recorder.ts`](src/recorder.ts))

Sessions are append-only JSONL files in `~/.agents/sessions/<project>/`, never inside the project:

- Every message is written the moment it joins the transcript, so a crash loses at most one line, and the loader skips a half-written last line.
- Compaction, mode switches and `/rewind` are records of their own.
- A `turn` record holds per-step usage, cache-hit rate, cache breaks, compactions and cost by role.
- A full run record with the transcript is written to `runs/run_<timestamp-with-ms>.json` next to the log.
- `--resume` continues the newest log. If there is none, it imports the newest legacy `test/run_*.json`.

### Late context ([`src/context.ts`](src/context.ts))

The reminder reports files that changed since the last step, with git queried asynchronously and with a timeout. The agent's own writes are not reported back to it, a stale-file note appears once per change, and files over 1 MB are compared by size and mtime instead of being hashed.

## Development

```bash
npm run check
```

That runs `typecheck` (`tsc --noEmit`), `lint` ([oxlint](https://oxc.rs), which forbids `require`/`__dirname` in this ES module codebase) and `test` (`node:test` through `tsx`). CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same, plus a build, on Linux, macOS and Windows. `npm run build` cleans `dist/` first.

The tests live in [`tests/`](tests/) and never call the real API:

- [`history.test.ts`](tests/history.test.ts): cap, strip, lock, fit, compaction helpers.
- [`security.test.ts`](tests/security.test.ts): permission escalation, path checks, the shared gate, `str_replace`, sandbox source.
- [`units.test.ts`](tests/units.test.ts): cache breakpoints and telemetry, elision, strip threshold, output sanitising, search tools, `read_file`, todos, browser gating.
- [`orchestration.test.ts`](tests/orchestration.test.ts): role allowlists, pipeline-mode tools, plan store, review parsing and rendering.
- [`loop.test.ts`](tests/loop.test.ts): the real loop against a scripted mock LLM ([`tests/helpers/mock.ts`](tests/helpers/mock.ts)) in a throwaway git repo. It covers the full pipeline with rework, the rework bound, cancellation, subagent timeouts, reasoning round-trip, `ask_user`, cache-break attribution, crash-safe session logs and change-note hygiene.

The audit's reproduction harness is in [`docs/audit/verification/`](docs/audit/verification/). Run a scenario against this checkout with:

```bash
cd docs/audit/verification && npx tsx verify_loop.ts A
```

## Audit status

| Phase | Items | Status |
|---|---|---|
| 1: critical fixes (P0-1 … P0-14) | Fail-safe `fit()`, compaction ordering and cooldown, pinned user requests, shared permission gate for subagents, invalid-JSON handling and step cap, working sandbox, permission bypasses, `str_replace` corruption, Windows shell, provider retries, full cost accounting, provider routing, tracked tests | Done (the audit's patch, plus the §6.7 wiring) |
| 2: architecture (1–14) | Structured review verdict with bounded rework, plans by reference, untracked-aware review baseline, subagent failure semantics and timeouts, enforced pipeline mode, cache-break telemetry, Anthropic breakpoints, strip threshold, argument elision, crash-safe sessions with `/sessions` and `/rewind`, Ctrl+C cancels the turn, reasoning round-trip, `context.ts` hygiene, browser gating | Done |
| 3: DX (15–19) | Input history, multiline input, no exit on empty Enter, streamed output, nested subagent panels with cost lines, wrapped and sanitised panels, per-step and per-role telemetry, `ask_user`, `grep`/`glob`, numbered and guarded `read_file`, bare `head`/`tail`, `node:test` suite, CI, lint, dead code removed, clean builds, forced `/compact` | Done. Lint uses oxlint rather than ESLint: `typescript-eslint` does not support TypeScript 7 |
