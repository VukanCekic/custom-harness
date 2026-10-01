# coding-harness — Architecture Audit v2: Roadmap Verification, Benchmark against neural-code, and Fix Plan

| | |
|---|---|
| **Audited revision** | `coding-harness` @ `74416fa` (branch `audit-implementation`, clean tree). 33 TypeScript files, 6,325 LOC in `src/`; 6 test files, 968 LOC |
| **Reference** | [`avbiswas/neural-code`](https://github.com/avbiswas/neural-code) @ `e3d2b9b`. 17 Python files, 1,700 LOC |
| **Date** | 2026-10-01 |
| **Supersedes** | The first audit at this path, written against `1e41f4a`. Its roadmap is what `74416fa` implements. To read it: `git show 74416fa:docs/codebase_audit_and_proposals.md` |
| **Companion files** | [`docs/audit/v2/fixes-v2.patch`](audit/v2/fixes-v2.patch): every fix in §6 (14 files, +757 / −189), with 10 regression tests. [`docs/audit/v2/p1…p9-*.mts`](audit/v2/): the probes behind every number in this report |

---

## 0. Method — what was actually done

This is a second audit. The first one found 34 defects. The two commits after it, `cbde00a` and `74416fa` (the latter +5,105 / −803 lines across 40 files), claim to implement its whole roadmap. So this audit answers two questions. Do those fixes hold? And what is wrong with the code as it stands now?

Every claim below was checked one of five ways. The evidence IDs in brackets are indexed in [Appendix A](#appendix-a--evidence-index-before--after-the-patch).

1. **Full read**. All 33 source files, the 6 test files and the CI/lint configuration were read line by line, along with all 17 files of the reference. The installed `@openrouter/sdk` 1.4.10 was also read where behaviour depended on it: its retry loop, its abort handling, and how it serialises `cache_control` and `tool_choice`.
2. **Baseline**. `tsc --noEmit` passes, `oxlint` passes, and `npm test` passes 42/42 in 6.5 s.
3. **Real-run forensics** `[RL]`. These are the five sessions and three run records the harness wrote into `~/.agents/sessions/coding-harness-bff36211/` *after* the roadmap landed, nine billed steps in all. From them come:
   - cache reuse per step;
   - estimator calibration against provider-reported `prompt_tokens`;
   - an exact per-token price fit;
   - two live defects: spill files needing approval to read, and line numbers doubled.

   The 45 pre-roadmap run records the first audit used (`test/run_*.json`) are no longer on disk, because `test/` is empty.
4. **Probes** `[S-*] [C-*] [L-*] [R-*] [B-*]`. Nine scripts in `docs/audit/v2/` import the real modules.
   - They run permission decisions, and execute real commands through the real gate in throwaway directories.
   - They drive the real `runAgent` / `runSubagent` / `compact` against the project's own scripted mock LLM in throwaway git repositories. The mock replaces `globalThis.fetch`, so nothing leaves the machine.
   - Every probe was run twice: against `74416fa` (**before**) and against the patched tree (**after**).
5. **Fix-and-verify** `[T]`.
   - Each fix in §6 was implemented in an isolated clone.
   - The patch was then applied to a *pristine* clone, where `tsc` and `oxlint` are clean and **52/52 tests** pass: the 42 existing tests plus 10 new regression tests, one per finding.
   - The first audit's own reproduction scenarios (`docs/audit/verification/verify_loop.ts` A, A2, D, E, G, H, I, J) were re-run against both trees `[V]`.

**Not done.**
- No live API calls were made: they cost money and send data out, and the mock exercises the same code.
- The Linux (bwrap) and macOS (seatbelt) sandbox paths were read, not run.
- `ripgrep` is not installed on the audit machine, so the `rg --pre` finding is decision-level. ripgrep's documented behaviour is that `--pre COMMAND` runs `COMMAND PATH` for every file searched.
- No offline tokenizer was available, so the non-Latin estimator finding [C-3] is qualitative.

---

## 1. Executive Summary

### Overall grade: **B−** today, **B+** with the patch in §6

The roadmap was implemented thoroughly, and most of it holds under stress. Every scenario the first audit used to reproduce its failures now passes, including the 100 %-tool-drop incident shape. The harness no longer goes blind in `fit()`. It compacts before paying for a request, and it pins the user's words verbatim across compactions. It gives subagents the same permission gate as the main loop, and it accounts for every cent.

The remaining defects cluster in three places:
- **failure paths the tests do not exercise**: an exhausted planner or reviewer, cancellation inside a subagent, output-token truncation, and compaction mid-tool-loop;
- **two places where the new fail-safe machinery itself can be fooled**;
- **a permission layer that is still an allowlist without a sandbox behind it** on Windows, the platform this harness actually runs on.

| Area | Today | With patch | One-line justification |
|---|---|---|---|
| Architecture & design intent | **A−** | A− | Invariants are written down next to the incidents that motivated them; one gate for every caller; scope, approver and asker travel in `AsyncLocalStorage`; a per-role ledger |
| Context management (`history.ts`) | **B** | A− | Fail-safe in every replayed scenario. But a tool result that merely *quotes* a marker is never stripped, and makes `fit()` mutate the transcript and then fail anyway `[C-1]` |
| Compaction (`compact.ts`) | **B−** | B+ | Ordering, cooldown, pinning and `$`-safety are solid `[V-J][V-H]`. It can summarise tool results the model has not read yet `[C-4]` |
| Subagents & orchestration | **C+** | B | Isolation and allowlists hold. On exhaustion, partial planner notes become the plan `[L-1]`, the reviewer cannot submit its verdict `[L-2]`, and Ctrl+C does not stop queued writes `[L-3]` |
| Agent loop & provider interface | **B** | B+ | Bounded retries including 429, a stall watchdog, a step cap and exact cost. `finish_reason=length` is misread as bad JSON and loops `[L-6]` |
| Tools | **B−** | B | Portable `grep`/`glob`, paging, literal CRLF-aware edits. But `grep` runs model-written regexes on the main thread `[R-1]`, and paging a spill file needs an approval and numbers lines twice `[C-2][L-8]` |
| Security (permissions + sandbox) | **D** | C− | One gate for every caller, but 19 risky commands/tool calls pass without a prompt `[S-1]`; 6 were executed end-to-end through the read-only gate `[S-2]`; no sandbox on Windows |
| Observability & UI | **B+** | B+ | Cost by role, cache-break attribution, per-step run records. Logs that stop at a user message do not say why `[RL]` |
| Tests & engineering | **B** | B+ | 42 tests, CI on three OSes, lint. Tests are not type-checked; no test covers exhaustion, cancellation inside subagents, or truncation |
| Economics | **B−** | B | 95–99 % of each previous request is reused `[RL]`. Pipeline mode re-prefills the whole prompt twice per turn `[L-4]`; compaction input is never cached; truncation loops burn output tokens `[L-6]` |

### Key strengths (verified)

- **The 100 %-drop failure is gone.** Replaying the incident shape `[V-A2]`, 0 of 7 results reach the model as `[output dropped]`, the user's constraint survives verbatim, and reported cost equals billed cost. At an unreachable budget, `fit()` refuses loudly and drops nothing `[V-A]`.
- **Compaction integrity.** After three successive compactions the user's original constraint is still verbatim, the earlier note is labelled `EARLIER HANDOFF NOTE`, and `$$`/`$&` survive literally `[V-J]`. A failed compaction no longer kills the turn `[V-H]`.
- **Prefix caching works by construction.** In the real runs every step reused 95–99 % of the previous request. What is lost is the late reminder plus rounding to the provider's 128-token cache blocks: every recorded `cached_tokens` value is a multiple of 128. No unexplained cache break was recorded `[RL]`.
- **One gate for every caller.** Truncated JSON is never run `[V-D]`. Read-only roles cannot even ask. Approvals reach the same human from inside subagents (tests).
- **Provider robustness.** 429 and 5xx are retried with bounded back-off, mid-stream errors surface, and a repeated `function.name` assembles correctly `[V-I]`. A 90 s stall watchdog backs this up.
- **Exact accounting.** The ledger covers main, subagents and compaction. The price fit against billed steps is exact `[B-2]`.

### Highest-priority vulnerabilities

| # | Sev. | Finding | Evidence | In patch |
|---|---|---|---|---|
| 1 | **P0** | **The allowlist is the only boundary on Windows, and it leaks.** `sort --out=`, `uniq IN OUT` and `find -fprint0` overwrite files through the *read-only* gate. `cat <.env`, `cat .en?` and the `grep` tool return the API key. `rg --pre`, `pytest` and PowerShell `(…)` / `@(…)` would run arbitrary code (decision-level). All of these are allowed without a prompt. | [S-1] [S-2] | patterns: yes; containment: no |
| 2 | **P0** | **Compaction can summarise results the model has not read.** With the default 64k window, one parallel read of 10 files (27k tokens) exceeds the 22.4k-token tail. The cut lands after the results, and the model is left with `[system, handoff]`: blind-by-summary. | [C-4] | yes |
| 3 | **P0** | **The fail-safe `fit()` can be fooled by file contents.** Lifecycle markers are found by substring. A result that contains `[output stripped:` (reading `src/history.ts` does; 7 files in this repo match) is never stripped. `fit()` prices it as droppable and refuses to drop it, so it **mutates the transcript and then fails anyway**, with a self-contradictory error. | [C-1] | yes |
| 4 | **P0** | **Ctrl+C does not stop a subagent.** After the user cancels, the worker's next queued `write_file` still runs. | [L-3] | yes |
| 5 | **P1** | **Exhaustion corrupts the pipeline.** A planner out of turns has its last narration *saved as the plan* (`"I was still looking at README.md."`). A reviewer out of turns is told "do not call any tools", so it cannot call `submit_review`. "No verdict" then counts as `changes_requested` and burns a rework cycle. | [L-1] [L-2] | yes |
| 6 | **P1** | **Output-limit truncation loops.** `finish_reason=length` is ignored, and the model is told to *"send the complete call again"*, which cannot fit. It repeats until `MAX_STEPS`. At 8,192 output tokens per step that is ~490k output tokens (~$0.59) per runaway turn, against $0.0003–$0.006 for a normal turn. | [L-6] [B-2] | yes |
| 7 | **P1** | **Orphaned processes on Windows.** A timeout or Ctrl+C kills the shell but not its children: test runners, dev servers, watchers. | [R-2] | yes |
| 8 | **P1** | **`grep` can freeze the harness.** The model's regex runs on the main thread. A backtracking pattern grows ×4 per two characters of input (264 ms at 26 chars warm, 2.5 s cold), and Ctrl+C, the spinner and the stall watchdog all stop meanwhile. | [R-1] | no (design in §5) |
| 9 | **P1** | **Pipeline mode is a cache bomb.** `plan_task` swaps the tool list, so the whole prompt is re-prefilled at the switch and again at the next turn (0 % reuse, both times). With cached input at 1/50 of the uncached price, each switch costs ~14× a normal step at 40k tokens. | [L-4] [B-2] | no (design in §5) |

---

## 2. Feature Health & Working Status Matrix

Status: ✅ **Working** (behaves as advertised) · ⚠️ **Fragile** (fails on reachable edge cases) · ❌ **Broken** (fails in normal use or under a demonstrated condition). "Patched" means the fix is in `fixes-v2.patch` and verified.

| Module | Feature | Status | Observed behaviour | Verification |
|---|---|---|---|---|
| `history.ts` | `cap()`: head + tail, spill to temp file | ✅ | Keeps the tail where test runners print the verdict; never splits a surrogate pair; each run sweeps only its own scope | unit tests |
| `history.ts` | Paging a spill file | ❌ → patched | Spill files sit in `%TEMP%`, outside the project. Every `read_file` of one asks for approval, and read-only roles are refused outright. A spilled `read_file` result is numbered again when paged (`105\t105\t…`), seen in a real session | [L-8] [C-2] [RL] |
| `history.ts` | `strip()` / `settle()` at turn end | ⚠️ → patched | Idempotent and size-gated. A result that contains a marker string is never stripped | [C-1a] |
| `history.ts` | `elide()` of finished call arguments | ✅ | Large `write_file` / `str_replace` bodies elided; reasoning dropped at turn end | unit tests |
| `history.ts` | `locked()` / `live()` | ✅ | Lock anchored to a *user* message that *starts with* the handoff opening; `live()` = trailing tool results | unit tests |
| `history.ts` | `fit()`: stub → elide → drop read → squeeze unread | ⚠️ → patched | Never drops an unread result, and refuses unreachable budgets in all replayed scenarios. A result that quotes a marker makes it price a cut it will not make: it **mutates the transcript, then still fails** | [V-A] [V-A2] [C-1b] |
| `history.ts` | `estimate()` | ⚠️ | Under-counts by 1–13 % vs the provider (n = 9); the worst steps were markdown-heavy. Assumes ~4 chars/token, so non-Latin scripts are under-counted by a multiple | [B-2] [C-3] |
| `compact.ts` | Trigger, placement, cooldown | ✅ | Before the request, overhead-aware, ¼-window cooldown: no cascade | [V-A] [V-J] |
| `compact.ts` | Handoff note, pinned requests | ✅ | User requests verbatim after 3 generations; `$`-safe; earlier note labelled | [V-J] |
| `compact.ts` | Failure handling | ✅ | A 400 from the summariser is noted; the turn completes | [V-H] |
| `compact.ts` | Where the tail is cut | ❌ → patched | Can cut past unread results: all 10 were summarised away, leaving `[system, handoff]` | [C-4] |
| `compact.ts` / `index.ts` | `/compact`, change detection | ⚠️ → patched | A compaction that replaces one message with one is paid for and applied, then reported as "Nothing to compact yet." and never logged. Auto-compaction has the same blind spot | [L-5] |
| `agent.ts` | Step cap, cancellation, cost | ✅ | Stops at `MAX_STEPS`; pending calls answered on Ctrl+C; reported cost equals billed cost | [V-E] [V-A2], tests |
| `agent.ts` | `ContextBudgetError` | ⚠️ → patched | Loud and lossless. No compaction is attempted when the cooldown blocked one. At low windows it advises `/compact`, which cannot help | [V-A] [B-1] |
| `agent.ts` | Output-limit truncation | ❌ → patched | Treated as malformed JSON; the model is told to resend the call | [L-6] |
| `agent.ts` | Pipeline mode switch | ⚠️ | Restricts tools correctly, but costs two full-prompt re-prefills per pipeline turn | [L-4] |
| `llm.ts` | Streaming, TTFT, throughput | ✅ | TTFT 389–1,054 ms; generation 247–353 tok/s in real runs | [RL] |
| `llm.ts` | Retries, stall watchdog, mid-stream errors | ✅ | 429 and 5xx retried with `Retry-After`; stalls aborted; in-band errors raised | [V-I] |
| `llm.ts` | Cancelling during back-off | ⚠️ | The SDK's sleep between attempts cannot be aborted, so Ctrl+C can wait up to 30 s (`maxInterval`) | SDK `lib/retries.js` |
| `llm.ts` | Tool-call assembly | ⚠️ | The name-repeat bug is fixed. Parallel calls whose deltas omit `index` collapse into one call with concatenated arguments | code |
| `llm.ts` | Anthropic `cache_control` breakpoints | ✅ (not live-tested) | Tools, system prompt, lock end, newest stable message. The SDK serialises `cacheControl` to `cache_control` | unit test, SDK `models/chatcontenttext.js` |
| `llm.ts` | Reasoning round-trip | ✅ | Streamed pieces merged and sent back | test |
| `execute.ts` | Shared gate | ✅ | Invalid JSON, unknown tool and no-approver all come back as readable results; nothing runs | [V-D], tests |
| `permissions.ts` | Command rules | ❌ → partly patched | 15/15 probe commands that write, execute or read credentials pass, along with 3/3 PowerShell subexpressions and `grep` on `.env`. Three overwrites and three secret reads were executed through the read-only gate | [S-1] [S-2] |
| `sandbox.ts` | OS sandbox | ❌ Windows · ⚠️ Linux/macOS | Windows: none (honestly reported). bwrap/seatbelt are correct by reading, but `/tmp` and `TMPDIR` are read-only inside them, which breaks many tools; there is no start-up probe for hosts where bwrap cannot create namespaces | code |
| `sandbox.ts` | Process clean-up | ❌ → patched | On timeout or Ctrl+C a grandchild process survives | [R-2] |
| `tools/bash.ts` | Shell | ⚠️ | Git Bash when installed (here: yes); `[exit code N]`; fixed 60 s timeout with no override for builds | code, [RL] |
| `tools/readFile.ts` | Read, number, page | ⚠️ → patched | Numbered and guarded. A long whole-file read spills, and is then numbered twice when paged | [C-2] |
| `tools/writeFile.ts`, `stringReplace.ts` | Edits | ✅ | `mkdir -p`; literal replacement; LF edits on CRLF files | tests |
| `tools/search.ts` | `grep`, `glob` | ⚠️ | Portable, `.gitignore`-aware, binary-safe. Regex on the main thread `[R-1]`; `grep` reads `.env` when given its path `[S-1]` | probes |
| `todos.ts`, `write_todos` | Plan injection | ✅ / ⚠️ | Validated, one in progress, re-injected every step. Not persisted, so lost on `--resume`, even though the prompt calls the block "the truth" | tests, code |
| `tools/askUser.ts` | Clarifying question | ✅ | Main agent only | test |
| `tools/browser.ts` | Automation | ✅ | `eval` asks; unknown hosts ask once per session | test |
| `subagent.ts` | Context isolation, allowlists | ✅ | Two messages in, one string out; no role can recurse | tests |
| `subagent.ts` | Context protection | ✅ | `fit()` every turn; requests plateau under the budget | [V-G] |
| `subagent.ts` | Cancellation | ❌ → patched | Queued calls run after Ctrl+C | [L-3] |
| `subagent.ts` | Exhaustion reporting | ⚠️ → patched | Running out of context is reported as "stopped after N turns" | code |
| `orchestrator.ts`, `pipeline.ts` | Plan by reference, untracked-aware baseline, bounded rework | ✅ | Happy path and rework bound tested | tests |
| `orchestrator.ts` | Planner exhaustion | ❌ → patched | Partial notes saved as the plan | [L-1] |
| `orchestrator.ts` | Reviewer exhaustion | ❌ → patched | Cannot submit, so `changes_requested` and a rework cycle burned | [L-2] |
| `session.ts` | Append-only JSONL, torn line, rewind | ✅ | | test |
| `session.ts` / `index.ts` | `--resume` selection | ❌ → patched | Every launch writes a log, so `--resume` picks the newest, often empty, one | [L-7] |
| `session.ts` / `index.ts` | Log write failure | ⚠️ → patched | An `appendFileSync` error (disk full, file locked) escapes and ends the turn | code |
| `cache.ts` | Cache-break telemetry | ✅ | Attributes tool-set changes and strips correctly | [L-4], test |
| `context.ts` | `<env>`, change and stale notes | ✅ | Own writes suppressed; each change reported once | tests |
| `ui.ts` | Panels, sanitising, streaming | ✅ / ⚠️ | Escape sequences stripped, lines wrapped. Tabs (every `read_file` line) and wide characters misalign panel borders | tests, code |
| `index.ts` | REPL: history, multi-line, Ctrl+C | — | Code inspection only; not exercised | — |
| `recorder.ts` | Run records | ✅ | Per-step usage, cache breaks, cost by role | [RL] |
| `tests/`, CI | Suite, lint, 3-OS matrix | ✅ / ⚠️ | 42/42 pass. Tests are not type-checked (`tsconfig` includes only `src/`, and tsx strips types). No sandbox-behaviour tests | run |

### 2.1 Failure modes and edge cases

| Event | Main loop | Subagents | Evidence |
|---|---|---|---|
| Process crash | At most the line being written is lost; a torn line is skipped on load. Spill files leak in `%TEMP%`; the browser can survive (the `exit` handler is async) | Transcript lost by design; the worker's edits stay on disk | test, code |
| Ctrl+C | Turn cancelled, pending calls answered. On Windows only the shell is killed. During 429/5xx back-off, up to 30 s pass before the cancel takes effect | **Queued calls still run** | [R-2] [L-3] |
| Network partition | Before the first byte: back-off up to 180 s, watchdog at 270 s. Mid-stream: 90 s stall, then an error. The partial reply is discarded but billed | Same, then `failed: …` plus `git status` | [V-I] |
| Out of context | Compaction, then `fit()`, then a loud `ContextBudgetError`. Gaps: [C-1b], [C-4], no emergency compaction | `fit()` each turn; out of context mislabelled; the planner's notes become the plan | [L-1] |
| Out of output tokens | Not detected: a retry loop for tool calls; a cut-off answer is shown as complete | Same | [L-6] |
| Endless tool loop | `MAX_STEPS = 60`, then "say continue". No detection of the same failing call repeating | 8–20 turns | [V-E] |
| Disk write failure | Spill: degrades gracefully. Session log: the exception ends the turn; a partial `sync` could duplicate lines on retry | Spill: graceful | code |
| Catastrophic regex | Event loop frozen: no spinner, no Ctrl+C, no watchdog | Same | [R-1] |
| Not a git repository | Snapshot, status and baseline return empty; the reviewer is told to read the worker's files | Same | code |

### 2.2 Code quality and architecture

- **Strengths.**
  - Small modules with one job each.
  - Every non-obvious rule carries a comment naming the incident behind it.
  - `AsyncLocalStorage` carries the cancel signal, role, approver and asker without threading parameters through every call.
  - Cache telemetry is keyed by transcript in a `WeakMap`.
  - Typed result objects (`Fit`, `Compaction`, `Spend`, `Review`).
- **Lifecycle state lives in prose.**
  - Whether a result is stubbed, dropped or spilled is decided by searching its *text* for markers. A spill path is recovered by regex from the same text. Tool output is arbitrary text, so both can be spoofed by accident [C-1].
  - A subagent's outcome is likewise inferred from the prefix of its report (`"(planner "`), which is how a partial run became a plan [L-1].
  - Structural state (a side table persisted in the session log, a typed outcome) removes the whole class.
- **Module-level singletons.** `SPILLS`, `LIVE`, `PLANS`, `TODOS`, `APPROVED_HOSTS`, the git state in `context.ts`, and the ledger are all module-level. Tests depend on order and process isolation, and parallel subagents are impossible without a refactor.
- **Presentation inside the runner.** `runSubagent` calls the `ui` singleton directly, where `runAgent` takes callbacks. A subagent cannot run headless.
- **Dead code.** `compact.needed()`, `tools/index.ts executeTool()` and `scope.cancelledByUser()` are exported and never called.
- **Documentation ahead of behaviour.**
  - The README says Ctrl+C cancels the turn and kills running commands; subagent calls continue [L-3], and grandchildren survive [R-2].
  - It says `--resume` "continues the newest log"; that is often an empty one [L-7].

---

## 3. Root-Cause Analysis — the tool-drop failure, then and now

### 3.1 The original failure

From the first audit's forensic record; the run file itself is no longer on disk.

In the run of 2026-10-01 17:16, every one of the 5 tool results in the final transcript read `[output dropped: dropped to fit the context window.]`, including `echo ok`. The user's "Do not touch src/" was lost across two generations of compaction, and the worker wrote into `src/`. Five defects compounded:

1. `fit()` dropped results the model had **not read yet**. It re-ran the command, the new result was dropped too, and the turn could never converge.
2. There was **no reachability check**. With a floor of 3,127 tokens against a budget of 2,975 (`CONTEXT_WINDOW = 3500`), it destroyed everything and still sent an over-budget request.
3. The budget **ignored the ~1.4k tokens of tool schemas**, so `fit()` and compaction disagreed about what fitted.
4. Compaction ran **after** each call, on every step: six times in one turn, each pass summarising the previous note, which was rendered as `USER:`.
5. The user's words were **never pinned**, so each generation paraphrased them further.

### 3.2 What the roadmap fixed — re-verified today

| Scenario (first audit's harness) | Original code (first audit) | `74416fa` (today) | With v2 patch |
|---|---|---|---|
| **A**: incident shape, `CONTEXT_WINDOW=3500` | 6 compactions; 5 of 7 results blinded; constraint erased | Refuses at step 1, before any request: *"needs ~3066 tokens … budget is 2975 (~2308 of it tool schemas). Raise CONTEXT_WINDOW or run /compact."* | *"The tool schemas and system prompt alone need ~2993 tokens, more than the 2975-token budget … /compact cannot help."* |
| **A2**: same, `CONTEXT_WINDOW=6000` | Completes; cost under-reported | Completes; **0/7 dropped**; constraint verbatim; reported = billed | same |
| **H**: summariser returns HTTP 400 | Turn rejected; paid reply discarded | Noted; turn completes | same |
| **J**: three compactions | `$`-mangled; constraint lost | Verbatim after 3 generations | same |
| **G**: subagent, 15 reads of 9 kB | Grew to 32k against 13.6k | Plateau ≤ 12.7k | same (≤ 11.0k) |
| **D / E / I**: truncated JSON / no step cap / provider errors | Ran with `{}` / 80 steps / 429 fatal | Error, nothing run / stops at `MAX_STEPS` / retried | same |

Scenario A also shows a new effect. The tool schemas grew from ~1,412 to ~2,008 tokens (14 tools now, 11 then), so the incident's own window no longer admits a single request.

### 3.3 How the fail-safe contract can still break

**(a) Marker text inside tool output** `[C-1]`. `strip()` skips any result whose text `includes("[output stripped:")` or `includes("[output dropped:")`; `fit()` uses the same test to decide what is already shrunk. Seven files in this repository contain those strings, among them `src/history.ts`, `tests/units.test.ts` and the audit documents. The harness's main user runs it on itself (`cwd: D:\code\coding-harness` in every recorded session).

- **strip**: a 10,247-character read of `src/history.ts` stays 10,247 characters forever.
- **fit**: the floor assumed that result could be dropped (*reported floor 391*), while the drop pass refused to drop it. The run came back with `fits = false` and the request still at 3,142 tokens against a 3,131 budget, **after** stubbing and dropping other results. That breaks the guarantee "when the budget is out of reach `fit()` changes nothing at all", and produces `ContextBudgetError: needs ~391 tokens … but the budget is 3131`, a message that contradicts itself.

The root cause is state encoded in content and recovered by substring. The patch recognises a stub only by its exact tail and a dropped result by exact equality. It prices the floor with the same predicates the passes use. And it makes `fit()` **transactional**: it works on a copy and commits only if the copy fits.

**(b) Compaction swallowing the live exchange** `[C-4]`. Compaction now runs before every request, mid-turn, which is right: it summarises what it removes, so it should go before `fit()`. But `tailStart()` keeps 0.35 W from the end and cuts at the first *safe* boundary. When the newest step's results alone exceed the tail, the only safe boundary is the end of the transcript.

With the default 64k window (22,400-token tail), ten parallel `read_file` results of 2,700 tokens each (27,000 in all) give a cut at 13 of 13. Everything, including the ten unread results, goes to the summariser, and the model resumes with `[system, handoff]`. It is the original failure in a new place: the model acts on a paraphrase of output it asked for and never saw.

neural-code cannot hit this, because it compacts only between turns, when every result has been read. The patch bounds the cut at the start of the live exchange. If those results are still too big, `fit()` squeezes them to a pointer at their spill file, which is invariant I1.

**(c) Refusing when one more compaction would do.** The ¼-window cooldown, which is correct, can block a compaction that would have made the request fit. `fit()` then fails and the turn dies with `ContextBudgetError`. The patch tries one compaction before refusing, provided the fixed overhead alone fits.

**(d) Estimation drift** `[B-2][C-3]`. Against nine billed steps, the provider counted 1.01–1.13× the estimate. The headroom between `COMPACT_AT = 0.85` and the real window is 15 %, so a 13 % under-count leaves almost none. For CJK or Cyrillic text, `chars / 4` under-counts by a multiple; `JSON.stringify` does not escape non-ASCII. Anchoring to the provider's last `prompt_tokens` fixes both (§5, P1-3).

**(e) Subagents.** When a subagent's `fit()` fails, the run is reported as *"stopped after 10 turns"*. For the planner, that report used to be saved as the plan.

### 3.4 Low `CONTEXT_WINDOW`, or a system prompt that exceeds the budget

| Mode | Fixed cost of every request | First request refused below | Start-up warning below |
|---|---|---|---|
| default | ~3,101 tokens: 14 tool schemas ~2,008 + system prompt ~793 + reminder reserve 300 | `CONTEXT_WINDOW` ≈ 3,666 | ≈ 7,300 |
| pipeline | ~2,119 tokens: 8 schemas ~1,097 + system ~722 + 300 | ≈ 2,511 | ≈ 5,000 |

The behaviour is now correct in kind. Nothing is dropped, the request is refused loudly, and `budgetWarning()` fires at start-up. Three gaps remain:

- The error recommends `/compact` even when the fixed overhead alone exceeds the budget. Compaction cannot shrink schemas or the system prompt. Patched: the message says so.
- Nothing bounds the system prompt. A custom `SYSTEM_PROMPT` or a large skills directory raises the floor one-for-one, and every skill description is paid on every request.
- Lowering `CONTEXT_WINDOW` to force compaction in tests makes the fixed share dominate. Lower `COMPACT_AT` / `COMPACT_TO` instead. A configuration where the fixed cost exceeds half the budget should be a start-up error unless forced.

### 3.5 The fail-safe contract, version 2

| Invariant | Mechanism | Status |
|---|---|---|
| **I1. Never blind (fit).** An unread result is never replaced by nothing | `live()`; squeeze to a spill pointer | ✅ since `74416fa` |
| **I1′. Never blind (compaction).** The live exchange is never summarised | Cut bounded at the start of the live exchange | patch [C-4] |
| **I2. All or nothing.** `fit()` either fits or leaves the transcript untouched | Transactional copy, committed only on success | patch [C-1b] (was: floor estimate only) |
| **I3. State is structural.** A marker counts only in the exact shape the harness writes | Anchored predicates; long term, a side table | patch |
| **I4. One budget.** The same overhead is counted by `fit()` and compaction | `overhead()` | ✅ |
| **I5. Summarise before refusing.** At least one compaction precedes `ContextBudgetError` | Emergency compaction past the cooldown | patch |
| **I6. Refuse precisely.** The error names the binding constraint | Fixed-overhead case split out; budget rounded | patch |
| **I7. Soft target, hard limit.** Shrink to 0.85 W; refuse only above W − max output | Two thresholds | proposal P1-4 |
| **I8. Anchored estimates.** Provider count for the shared prefix, estimate only for the new tail | Last `prompt_tokens` + `estimate(delta)` | proposal P1-3 |
| **I9. Subagents say how they ended.** `out_of_context` ≠ `out_of_turns`; only `done` becomes a plan | `SubagentOutcome` | patch [L-1] |

---

## 4. Comparative Analysis with `neural-code`

### 4.1 Lineage

`neural-code` is a 15-stage tutorial harness of 1,700 lines. `coding-harness` began as a module-for-module TypeScript port; several docstrings are translations, and the seatbelt profile is still written to `neuralcode.sb`. It is now 3.7× the size, adding:
- the planner → worker → reviewer pipeline;
- streaming telemetry;
- a browser tool;
- portable search;
- Windows support;
- crash-safe sessions;
- the context-safety machinery the first audit called for.

### 4.2 Dimension by dimension

| Dimension | `neural-code` (reference) | `coding-harness` @ `74416fa` | Gap / divergence |
|---|---|---|---|
| **Prefix caching** | Late-injected `<env>`/`<todos>` reminder, never stored. `locked()` = last message *containing* `<summary>`. Compaction only between turns. Strip at every turn end. Constant tool list. No explicit breakpoints | Same late injection: each step reuses 95–99 % of the previous request [RL]. `locked()` anchored to the handoff opening of a user message. Compaction before a request, ¼ W cooldown. Strip only past `STRIP_AFTER`. Cache-break telemetry with blame. Anthropic breakpoints. **`plan_task` swaps the tool list: two full re-prefills per pipeline turn** [L-4] | Harness better instrumented and provider-aware. One regression the reference cannot have, since its tool list never changes |
| **Tool lifecycle** | `cap` (10k, head only) → `strip` (300) → `fit`: drop oldest, read *or unread*. One marker (`[output trimmed:`) doubles as the "done" flag, so capped results are never stripped | `cap` keeps head and tail, surrogate-safe → `strip`/`elide` at turn end → `fit`: stub → elide → drop read → squeeze unread to a pointer; refuses when unreachable. Four markers, **still detected by substring** [C-1]; spill files gated as outside the project [L-8] | Harness far stronger. The substring-marker weakness is inherited; the reference has it only for one marker |
| **Compaction strategy** | Same 5-section handoff prompt; tail 0.35 W; trigger on last `prompt_tokens > 0.85 W`, *after* the turn; `try/except`; `str.format` | Same prompt and ratios. Estimate-based trigger before each request; cooldown; **user requests pinned verbatim**; `$`-safe; earlier note labelled; non-fatal; cost returned. **Can summarise the live exchange** [C-4]; same-length rewrite invisible [L-5] | Harness better on every axis but one, and that one exists because it compacts mid-turn |
| **Subagent protocol** | 2-message start; shared `execute()`; `fit()` per turn; **denylist** `{"task","write_todos","str_replace","write"}` (the typo leaves `write_file` available); 12 turns; partial findings on exhaustion | 2-message start; shared gate via `AsyncLocalStorage`; **per-role allowlists**; read-only roles cannot ask; own spill scope; `fit()` per turn; deadline; failure report with `git status`; plan store; untracked-aware review baseline; structured `submit_review`; bounded rework. **Failure paths broken**: [L-1] [L-2] [L-3] | Harness much more capable; its exhaustion and cancel semantics lag its own design |
| **Tool-calling model** | Native OpenAI-style calls, non-streaming; invalid JSON → error; signature mismatch → error | Native calls, streamed and assembled by `index` (name-repeat fix); invalid JSON → error, nothing run. **`finish_reason=length` not detected** [L-6]; deltas without `index` merge into one call | Parity on parsing. Neither handles truncation; the harness's streaming adds an assembly edge case |
| **Robustness & edge cases** | OpenAI SDK defaults (2 retries, 10-minute timeout); 60 s subprocess timeout; JSONL appended per message; no step cap; no cancellation | Bounded retries including 429; stall watchdog; step cap; cancellation; crash-safe JSONL with `replace`/`rewind` records; per-role ledger. Orphaned processes on Windows [R-2]; non-abortable back-off; unguarded log writes; `grep` blocks the loop [R-1] | Harness far more robust overall |
| **Permissions & sandbox** | `rm`, `sudo`, `curl`, `git push` / `reset` / `clean` **denied** even with approval; `fnmatch` (newline bypass); seatbelt + bwrap; none on Windows | `ask` instead of deny; newline-safe; quote-aware effects scan; risky flags; secret paths; read-only roles refuse. **19 allow-listed bypasses** [S-1]; sandbox fixed on macOS/Linux; **none on Windows** | Both depend on the OS sandbox. On Windows, the platform in use, both are pattern-only |
| **Sessions** | JSONL per chat; `/rewind`, `/sessions`; tolerant loader | Same plus `replace`/`turn` records, run records, legacy import. `--resume` picks empty logs [L-7]; todos not persisted | Parity plus telemetry; two small regressions |

### 4.3 What `neural-code` does better

1. **One code path per guarantee.** Its subagent returns partial findings from a single place, and there is no plan store to poison. Fewer moving parts meant fewer failure-path bugs: every defect in [L-1]–[L-3] lives in machinery the reference does not have.
2. **A constant tool list.** It never pays for a tool-set cache break.
3. **Between-turn compaction**, which can never see an unread result [C-4].
4. **`deny` for destructive and network commands.** A tired human cannot approve `rm -rf` by reflex.
5. **Non-streaming calls**, so there are no assembly edge cases (missing `index`, repeated names).
6. **A 128k default window.** For models that support it, the lossy, uncached compaction runs half as often; the harness defaults to 64k regardless of model.
7. **A guardrail in its subagent prompt**: "never search from / or from the home directory". The harness's research prompt lacks it. The 60 s timeout would kill such a scan, but the turn is wasted.

### 4.4 What `coding-harness` improved

1. **Fail-safe context management**: unread results protected, unreachable budgets refused, overhead counted once, compaction before `fit()`, cooldown.
2. **Compaction that cannot paraphrase the user away**: verbatim `<request>` pins across generations, `$`-safe substitution, labelled earlier notes.
3. **Authority isolation as well as context isolation**: subagents ask the same human through async context, read-only roles cannot ask, and allowlists replace a typo-prone denylist.
4. **A real pipeline**: plans by reference, an untracked-aware baseline the reviewer diffs against, a structured verdict, rework bounded in code.
5. **Provider robustness**: 429 and 5xx with bounded back-off, a stall watchdog, mid-stream errors, a role-attributed ledger, Anthropic breakpoints, reasoning round-trip.
6. **Operational quality**: crash-safe sessions with rewind and replace records; cache-break telemetry; Git Bash on Windows; portable `grep`/`glob`; paging; literal CRLF-aware edits; ANSI-safe output; tests and a three-OS CI.

### 4.5 Where `coding-harness` falls short of the reference

| Reference property | Harness today | Evidence |
|---|---|---|
| Tool list never changes | Pipeline mode swaps it twice per pipeline turn | [L-4] |
| Compaction sees only read results | Mid-turn compaction can summarise unread ones | [C-4] |
| Destructive commands denied outright | Approvable (`ask`) | code |
| 128k default window | 64k default regardless of model | `config.ts` |
| Simple exhaustion semantics | Partial plan stored; reviewer cannot submit; cancel not checked between a subagent's calls | [L-1] [L-2] [L-3] |

### 4.6 Architectural takeaways

1. **Put state in structure, not in text.** Markers in tool output and status in report prefixes are both parsed back out of content that can contain anything. Each defect in [C-1] and [L-1] is one instance of that.
2. **Every guarantee needs its failure path tested.** The roadmap's happy paths are well covered. Every new defect here sits on an exhaustion, cancel or truncation path that no test reaches.
3. **An allowlist is friction, not a boundary.** `write_file` is unprompted inside the project, and allow-listed commands can run project code or write files, so the allowlist only decides when to interrupt. Containment has to come from the OS (WSL2 with bwrap, or a container, on Windows), or read-only roles must be given no general-purpose shell at all.
4. **Let cache prices drive design.** With cached input at 1/50 of the uncached price `[B-2]`, any edit to the prefix costs about 50× its token count. Changing the tool list, the compaction prompt's shape, or a strip is a pricing decision, and should be measured as one.
5. **Moving compaction before the call creates a new invariant.** Summarise only what the model has already read.

### 4.7 Economic & latency feasibility

| Metric | Value | Source |
|---|---|---|
| Prices (deepseek-v4.1-flash via OpenRouter) | **$0.300 / M** uncached input, **$0.006 / M** cached (1/50), **$1.200 / M** output; exact least-squares fit, 0.0 % error | [B-2] |
| Cache reuse per step | 95–99 % of the previous request (e.g. 3,968 of 4,028; 8,064 of 8,131); every `cached_tokens` value a multiple of 128 | [RL] |
| Cache hit per turn | 63 %, 69 %, 95 % for 4-, 4- and 1-step turns, limited by *new* tool output, not breaks (0 breaks recorded) | [RL] |
| Cost per turn | $0.00029 (1 step), $0.0021 (4 steps, browser), $0.0059 (4 steps, repo exploration) | [RL] |
| Latency | TTFT 389–1,054 ms (9 steps); generation 247–353 tok/s, end-to-end 146–281 tok/s (final step of each run) | [RL] |
| Fixed overhead per request | ~3,101 tokens (4.8 % of 64k): $0.0009 when uncached, $0.00002 when cached | [B-1] |
| **Pipeline mode switch** | 2 full re-prefills per pipeline turn. At 40k tokens: 2 × 40k × ($0.300 − $0.006)/M ≈ **$0.024**, against $0.0008 for a cached 40k-token step | [L-4] |
| **Truncation loop** | 8,192 × $1.20/M ≈ $0.0098 per step; **≈ $0.59 per 60-step runaway turn**, 100–2,000× a normal turn | [L-6] |
| Compaction at W = 64k | ≈ **$0.019**: summariser input ~32k uncached ($0.0096) + note ~1.5k ($0.0018) + rebuilt prefix ~25k ($0.0074). Continuation-style compaction (P1-2) ≈ $0.0095 | estimate |
| Strip payoff | It pays after N = (50·T − U)/(U − T) further requests, where U is the turn's size before the strip and T after. Ten 10k-char results: N ≈ 2. Results just over 300 chars: never | formula, [B-2] |
| Pipeline latency bound | planner ≤ 11 + worker ≤ 21 + reviewer ≤ 9 = **41 sequential calls** per pass, about 1–2 minutes of model time before tools; up to 3 passes with rework | code, [RL] |

**Verdict.** Subagents are cheap in tokens, because their system prompts and schemas cache across runs, but expensive in latency, because every turn is a sequential round trip. The main loop's cache design pays off strongly at a 50:1 price ratio. The three things that waste money are mechanical and fixable: the tool-set switch, uncached compaction input, and truncation loops.

---

## 5. Concrete Proposals & Recommendations

Effort: **S** < 2 h · **M** ≈ ½ day · **L** 1–2 days. "Patch" means implemented in [`docs/audit/v2/fixes-v2.patch`](audit/v2/fixes-v2.patch) and verified by the named regression test and probe.

### Phase 1 — Immediate critical fixes (P0)

| ID | Problem | Fix | Files | Effort | Status · verified by |
|---|---|---|---|---|---|
| P0-1 | Markers found by substring: results never stripped; `fit()` mutates and then fails | Exact-shape predicates (stub tail, dropped note); floor priced by the same rules; **transactional** `fit()`; squeeze size projected without writing a file; the live call keeps its reasoning | `history.ts` | S | Patch · `F-CTX-1`, [C-1] |
| P0-2 | Compaction summarises unread results | Cut never past the start of the live exchange; `Compaction.changed` instead of a length comparison | `compact.ts` | S | Patch · `F-CMP-1`, [C-4] [L-5] |
| P0-3 | Ctrl+C does not stop a subagent's queued calls | Check the signal before every call; answer the remaining calls; throw | `subagent.ts` | S | Patch · `F-SUB-3`, [L-3] |
| P0-4 | Partial planner notes become the plan; out-of-context mislabelled | `runSubagentDetailed()` returns `{status, text}`; `plan_task` saves only `done`; `out_of_context` status | `subagent.ts`, `orchestrator.ts` | S | Patch · `F-SUB-1`, [L-1] |
| P0-5 | Reviewer out of turns cannot submit; rework burned | The last turn offers only `submit_review` with `tool_choice: "required"` and runs it through the gate | `subagent.ts`, `llm.ts` | S | Patch · `F-SUB-2`, [L-2] |
| P0-6 | `finish_reason=length` read as bad JSON; resend loop | Surface `finishReason`; answer cut-off calls with split-it-up advice and never run them; flag cut-off answers; optional `MAX_OUTPUT_TOKENS` | `llm.ts`, `execute.ts`, `agent.ts`, `subagent.ts` | S | Patch · `F-LLM-1`, [L-6] |
| P0-7 | 19 allow-listed bypasses | Rules for `sort -o…/--o…`, `uniq IN OUT`, `find -fprint0`, `tree -o…`, `rg --pre`, `date -s`, `git branch -u/-t/…`, `git diff --no-index`. Secret detection on shell *words* (quotes, escapes, `<`, globs by the shell's dot rule). PowerShell `(…)`/`@(…)`. **Strict mode** for callers that cannot ask (no test runners). `grep`/`glob` on secret paths ask | `permissions.ts`, `execute.ts` | M | Patch · `F-SEC-1`, [S-1] [S-2]. Residual: `grep -r` can still reach `.env`; `pytest` with a human still runs project code |
| P0-8 | **No containment on Windows** | Patterns cannot fix it. (1) Document and support running inside **WSL2**, where the existing bwrap path works, or a dev container. (2) Until then, print a warning at start-up, and give read-only roles a minimal allowlist with no interpreters and no test runners. (3) Optionally run commands under a Job Object with a restricted token | `sandbox.ts`, `permissions.ts`, README | M–L | **Not in patch** |
| P0-9 | Orphaned processes on Windows | One spawn path for every OS; `taskkill /T /F` on Windows, process-group `SIGKILL` on POSIX; stdin closed so a bare `cat` gets EOF | `sandbox.ts` | S | Patch · `F-RUN-1`, [R-2] |
| P0-10 | `grep` regex blocks the event loop | Run the search in a `worker_threads` Worker with a deadline (10 s), terminated on timeout; or use a linear-time engine (RE2); keep the line cap | `tools/search.ts` | M | **Not in patch** · [R-1] |
| P0-11 | Spill files: an approval per read, refused for read-only roles, numbered twice | `isSpill()` registry of live spill files, allowed for `read_file`/`grep`; `read_file` pages long files itself instead of spilling them | `history.ts`, `permissions.ts`, `readFile.ts` | S | Patch · `F-TOOL-1`, [L-8] [C-2] |
| P0-12 | `--resume` picks an empty log; same-length compaction not logged; a log write failure ends the turn | `resumable()`; `onTranscript(messages, "compaction")` records the rewrite; guarded `record()`; `written` advanced per line | `session.ts`, `index.ts`, `agent.ts` | S | Patch · `F-SES-1`, [L-7] [L-5] |
| P0-13 | `ContextBudgetError` where one compaction would do; misleading at low windows | One compaction past the cooldown before refusing; message distinguishes fixed overhead; budget rounded | `agent.ts` | S | Patch · [V-A] |

### Phase 2 — Architectural improvements (P1)

**Prompt caching**

1. **P1-1. A cache-stable pipeline mode.** Keep one tool list for the whole session. Enforce "coordinate only" at the gate: a write in pipeline mode gets *"in pipeline mode edits go through work_task"*. Announce the mode in the late reminder. This removes two full re-prefills per pipeline turn ([L-4], ≈ $0.024 at 40k tokens) and the TTFT they add. **M**
2. **P1-2. Continuation-style compaction.** Send the *cached* transcript, with the same tools and `tool_choice: "none"`, plus a final "write the handoff note" message, instead of a fresh `SYSTEM + render()` prompt with no shared prefix. The summariser's input then hits the cache: roughly half the cost of a compaction at measured prices, and lower latency. **M**
3. **P1-3. Anchored token estimates.** Remember the provider's `prompt_tokens` for the last request and the size of its stable prefix. Estimate only the delta. This removes the 1–13 % drift [B-2] and the script bias [C-3], and lets `fit()` and compaction trigger on near-exact numbers. **S**
4. **P1-4. Soft target, hard limit.** `fit()` aims at `COMPACT_AT · W`. `ContextBudgetError` fires only above `W − max_output`; between the two, send with a note. Fail loudly only where the provider would fail. **S**
5. **P1-5. A strip policy that pays.** Strip a result only if it is ≥ ~2,000 chars (its stub ≤ 15 % of it), and elide arguments on the same rule. Gate on the measured price ratio from the ledger (§4.7) rather than on transcript size alone. **S**

**Subagent coordination**

6. **P1-6. A strict reviewer.** Make the reviewer `readOnly`, plus *one* approved test command per project, taken from configuration or `package.json`, instead of open-ended approvals. Its "never edit" becomes structural rather than a sentence in the prompt. **S**
7. **P1-7. Typed outcomes end to end.** Return `SubagentOutcome` to the main agent as a field: `status: out_of_turns`. Configure turn limits and deadlines per role (`PLANNER_MAX_TURNS`, `WORKER_TIMEOUT_MS`); the worker usually needs more than the 10-minute default. **S**
8. **P1-8. Structural lifecycle state.** Keep a side table, `message → {state, spill, size}`, persisted as session records, so neither markers nor paths are ever parsed back out of tool output. This retires the anchored-marker stopgap of P0-1. **M**

**Error recovery and loop control**

9. **P1-9. A repetition breaker.** If the same tool, with the same arguments, returns the same error three times, end the turn with a message. This complements P0-6 for loops that advice cannot break. **S**
10. **P1-10. An abortable retry loop.** Turn the SDK retries off and back off in `llm.ts` with an abortable sleep. Ctrl+C becomes immediate during 429/5xx back-off, and every attempt is logged in the ledger. **S**
11. **P1-11. A model-aware window.** Read `context_length` from OpenRouter's `/models` once (cached in `~/.agents`). Default `CONTEXT_WINDOW` to it, and warn when the configured value exceeds it. **S**
12. **P1-12. Usable sandboxes on Linux and macOS.**
    - bwrap: add `--tmpfs /tmp`.
    - seatbelt: point `TMPDIR` inside the project.
    - Probe once at start-up (`bwrap --ro-bind / / true`) and fall back with an explicit message on hosts that restrict unprivileged user namespaces (some Ubuntu releases since 23.10 via AppArmor, many containers).
    - Cache `hasBwrap()`, which spawns a shell on every call.
    - Add sandbox-behaviour tests to the Linux and macOS CI jobs.

    **M**
13. **P1-13. Tool-call assembly by `id`.** When a delta carries a new `id` at a reused or missing `index`, start a new call instead of concatenating arguments. **S**
14. **P1-14. Session completeness.**
    - Persist `write_todos` as a record and restore it on `--resume`.
    - Refresh the system prompt (mode, cwd, skills) on resume.
    - Write an `error` record when a turn fails, so a log that ends at a user message explains itself [RL].

    **S**

### Phase 3 — DX & feature enhancements (P2)

15. **UI.** Expand tabs and measure East-Asian width in `renderPanel` (every `read_file` panel is misaligned today). Show a per-step cache-hit line. Add `/cost` and `/context` commands: window usage, recent breaks, and what they cost.
16. **Telemetry.** Count refusals, truncations, compactions and cache breaks in the run record, priced in dollars from the fitted rates.
17. **Providers.**
    - Expose the SDK's `serverURL` (`BASE_URL`) for OpenRouter-compatible gateways.
    - Add a small OpenAI-compatible adapter for direct DeepSeek or Together endpoints.
    - Add capability flags for `cache_control`, reasoning and `tool_choice`.
18. **Tools.**
    - A bounded `timeout_s` argument on `bash` (≤ 600 s) for builds.
    - `cwd` on `bash`.
    - A `read_file` page size.
    - Optionally, parallel *read-only* `task` subagents, once the module singletons are scoped (§2.2).
19. **Engineering.**
    - Type-check the tests (`tsconfig.tests.json`, `tsc -p`).
    - Delete `compact.needed`, `executeTool` and `cancelledByUser`.
    - Correct the README's Ctrl+C and `--resume` claims.
    - Create a session file on the first message, not at launch.
    - Decouple `runSubagent` from the `ui` singleton with callbacks.

---

## 6. Reference Code Diffs

The diffs below are the per-file contents of [`docs/audit/v2/fixes-v2.patch`](audit/v2/fixes-v2.patch), generated against `74416fa`. Applied to a pristine clone, `tsc` and `oxlint` are clean, all 52 tests pass (42 existing + 10 new in `tests/regressions.test.ts`), and the first audit's scenarios still pass.

```bash
git apply docs/audit/v2/fixes-v2.patch
```

```bash
npm run check
```

Run any probe against the patched tree to see its "after" column:

```bash
npx tsx docs/audit/v2/p4-loop.mts
```

| § | Fix | Findings |
|---|---|---|
| 6.1 | Fail-safe context lifecycle: structural markers, transactional `fit()`, live-spill registry | P0-1, P0-11 · [C-1] [L-8] |
| 6.2 | Compaction never swallows the live exchange; loop: emergency compaction, precise refusal, truncation | P0-2, P0-6, P0-12, P0-13 · [C-4] [L-5] [L-6] |
| 6.3 | Subagent outcomes: cancel stops calls, typed status, reviewer can always submit, planner never saves partial notes | P0-3, P0-4, P0-5 · [L-1] [L-2] [L-3] |
| 6.4 | Provider interface: `finishReason`, `toolChoice`, `cutOff()`, strict gate | P0-5, P0-6, P0-7 |
| 6.5 | Permission hardening | P0-7 · [S-1] [S-2] |
| 6.6 | Process-tree kill | P0-9 · [R-2] |
| 6.7 | Small fixes: `read_file` paging, `--resume`, guarded session log, mock `finishReason` | P0-11, P0-12 |

### 6.1 Fail-safe context lifecycle — `src/history.ts`

Lifecycle state is recognised by its exact shape, so file contents cannot impersonate it. `fit()` works on a copy and commits only if the copy fits. The floor is priced by the same rules the passes follow, and the squeeze size is projected without writing a file. Spill files are registered, so the permission check can let agents page their own output.

<details><summary>Show diff — <code>src/history.ts</code> (+93 / −38)</summary>

```diff
diff --git a/src/history.ts b/src/history.ts
index 74be93d..3c9e987 100644
--- a/src/history.ts
+++ b/src/history.ts
@@ -44,6 +44,9 @@ export const HANDOFF_OPENING = `${SUMMARY}\nEverything before this point has bee
 
 const DROPPED_NOTE = `${DROPPED} dropped to fit the context window.]`;
 
+const STUB_END = /\n\n\[output stripped: \d+ more chars\. Run the command again if you need them\.\]$/;
+const PARKED = /\[output trimmed: \d+ of \d+ chars cut from the middle\. The whole output is at (.+?) - page through it with head, tail, or read_file\./;
+
 const ELIDE_MIN = 500; // chars - an edit argument shorter than this stays verbatim
 const ELIDE_ANY = 2_000; // chars - any other string argument longer than this goes
 
@@ -56,11 +59,36 @@ export type SpillScope = string[];
 /** The main agent's current turn. Subagents bring their own scope. */
 export const SPILLS: SpillScope = [];
 
+/** Every spill file still on disk, whichever run owns it. */
+const LIVE = new Set<string>();
+const spillKey = (filePath: string) => {
+  const resolved = path.resolve(filePath);
+  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
+};
+
+/**
+ * Is this one of the harness's own live spill files? They sit in the OS temp
+ * directory, outside the project, so without this every attempt to page one
+ * needed an approval - and read-only subagents were refused outright.
+ */
+export function isSpill(filePath: string): boolean {
+  return LIVE.has(spillKey(filePath));
+}
+
 function text(message: ChatMessages): string {
   const raw = (message as any)?.content;
   return typeof raw === "string" ? raw : "";
 }
 
+/**
+ * What a result already is, judged by the exact shape strip() and fit() give
+ * it - never by a marker appearing somewhere inside. A result that merely
+ * quotes a marker (reading this file does) used to count as stripped forever,
+ * and fit() priced it as droppable while refusing to drop it.
+ */
+const isStub = (content: string) => STUB_END.test(content);
+const isDropped = (content: string) => content === DROPPED_NOTE;
+
 // ------------------------------------------------------------------- 1. cap
 
 /**
@@ -71,6 +99,7 @@ export function spill(text: string, scope: SpillScope = SPILLS): string {
   const filePath = path.join(os.tmpdir(), fileName);
   fs.writeFileSync(filePath, text, "utf-8");
   scope.push(filePath);
+  LIVE.add(spillKey(filePath));
   return filePath;
 }
 
@@ -119,6 +148,7 @@ export function cap(
  */
 export function sweep(scope: SpillScope = SPILLS): void {
   for (const filePath of scope) {
+    LIVE.delete(spillKey(filePath));
     try {
       fs.rmSync(filePath, { force: true });
     } catch {
@@ -185,7 +215,7 @@ export function strip(messages: ChatMessages[], protectLive = false): number {
   for (let index = locked(messages); index < end; index++) {
     const message = messages[index] as any;
     const content = text(message);
-    if (message.role !== "tool" || content.includes(STRIPPED) || content.includes(DROPPED) || content.length <= stubLimit) {
+    if (message.role !== "tool" || isStub(content) || isDropped(content) || content.length <= stubLimit) {
       continue;
     }
     message.content = stub(content);
@@ -288,13 +318,27 @@ export function estimate(messages: ChatMessages[]): number {
 
 /** Re-cap an unread result to SQUEEZE chars, reusing its spill file if it has one. */
 function squeeze(content: string, scope: SpillScope): string {
-  const parked = content.match(/The whole output is at (.+?) - page through it/)?.[1];
-  if (parked && fs.existsSync(parked)) {
+  // Only a pointer cap() itself wrote, to a file it still owns - not a path
+  // that happens to appear in the output.
+  const parked = content.match(PARKED)?.[1];
+  if (parked && isSpill(parked) && fs.existsSync(parked)) {
     return cap(fs.readFileSync(parked, "utf-8"), scope, SQUEEZE, parked);
   }
   return cap(content, scope, SQUEEZE);
 }
 
+/** What squeeze() would leave of a message, priced without writing a file. */
+function squeezedSize(message: ChatMessages): number {
+  const content = text(message);
+  const head = Math.floor(SQUEEZE * 0.7);
+  const pointer =
+    `\n\n${TRIMMED} ${content.length} of ${content.length} chars cut from the middle. The whole output is at ` +
+    `${path.join(os.tmpdir(), "customharness-tool-0000000000000-000000.txt")} - page through it with ` +
+    "head, tail, or read_file. It is deleted when this turn ends.]\n\n";
+  const kept = content.slice(0, head) + pointer + content.slice(content.length - (SQUEEZE - head));
+  return estimate([{ ...(message as any), content: kept } as ChatMessages]);
+}
+
 export interface Fit {
   tokens: number; // estimated request size afterwards, overhead included
   floor: number; // the smallest fit() could have made it
@@ -308,10 +352,11 @@ export interface Fit {
 /**
  * Last resort: shrink tool results until the request fits.
  *
- * Prices the deepest possible cut before making any. If even that cannot
- * reach the budget, nothing is touched - throwing every result away on the
- * way to failing anyway is how past runs went blind - and the caller has to
- * compact or stop instead. Normally a no-op: cap, strip and compaction do the
+ * Prices the deepest possible cut before making any, and works on a copy
+ * that is committed only if it fits. Either the request fits afterwards or
+ * the transcript is exactly as it was: throwing results away on the way to
+ * failing anyway is how past runs went blind. When it cannot fit, the caller
+ * has to compact or stop. Normally a no-op: cap, strip and compaction do the
  * real work.
  */
 export function fit(
@@ -321,7 +366,8 @@ export function fit(
   scope: SpillScope = SPILLS
 ): Fit {
   const sizes = messages.map((m) => estimate([m]));
-  let tokens = overhead + sizes.reduce((sum, n) => sum + n, 0);
+  const total = overhead + sizes.reduce((sum, n) => sum + n, 0);
+  let tokens = total;
   const result: Fit = { tokens, floor: tokens, fits: tokens <= budget, stubbed: 0, elided: 0, dropped: 0, squeezed: 0 };
   if (result.fits) {
     return result;
@@ -331,72 +377,81 @@ export function fit(
   const read: number[] = [];
   const unread: number[] = [];
   // Tool-call arguments used to be irreducible: one 200k-char write_file
-  // could put a request out of reach for good.
+  // could put a request out of reach for good. The call whose results are
+  // still unread keeps its reasoning: its tool loop is not over.
   const slim = new Map<number, ChatMessages>();
   for (let index = locked(messages); index < messages.length; index++) {
     if (messages[index].role === "tool") {
       (index < fresh ? read : unread).push(index);
     }
-    const next = slimmed(messages[index]);
+    const next = index === fresh - 1 && fresh < messages.length ? null : slimmed(messages[index]);
     if (next) slim.set(index, next);
   }
+  const squeezable = (index: number) => text(messages[index]).length > SQUEEZE + 400;
 
+  // The deepest cut, priced by the same rules the passes below follow.
   const droppedSize = estimate([{ role: "tool", toolCallId: "", content: DROPPED_NOTE } as ChatMessages]);
-  const squeezedSize = Math.ceil((SQUEEZE + 400) / 4);
   result.floor =
-    tokens -
+    total -
     [...slim].reduce((sum, [i, next]) => sum + Math.max(0, sizes[i] - estimate([next])), 0) -
-    read.reduce((sum, i) => sum + Math.max(0, sizes[i] - droppedSize), 0) -
-    unread.reduce((sum, i) => sum + Math.max(0, sizes[i] - squeezedSize), 0);
+    read.reduce((sum, i) => sum + (isDropped(text(messages[i])) ? 0 : Math.max(0, sizes[i] - droppedSize)), 0) -
+    unread.filter(squeezable).reduce((sum, i) => sum + Math.max(0, sizes[i] - squeezedSize(messages[i])), 0);
   if (result.floor > budget) {
     return result;
   }
 
-  const replace = (index: number, content: string) => {
-    (messages[index] as any).content = content;
-    const next = estimate([messages[index]]);
-    tokens += next - sizes[index];
-    sizes[index] = next;
+  // Entries of the copy are replaced, never edited, so the original is
+  // untouched until the commit below.
+  const work = [...messages];
+  const replace = (index: number, next: ChatMessages) => {
+    work[index] = next;
+    const size = estimate([next]);
+    tokens += size - sizes[index];
+    sizes[index] = size;
   };
+  const withContent = (index: number, content: string) => ({ ...(work[index] as any), content }) as ChatMessages;
+  const done = { stubbed: 0, elided: 0, dropped: 0, squeezed: 0 };
 
   // 1. stub what the model has already read, oldest first
   for (const index of read) {
     if (tokens <= budget) break;
-    const content = text(messages[index]);
-    if (content.includes(STRIPPED) || content.includes(DROPPED) || content.length <= STUB) continue;
-    replace(index, stub(content));
-    result.stubbed++;
+    const content = text(work[index]);
+    if (isStub(content) || isDropped(content) || content.length <= STUB) continue;
+    replace(index, withContent(index, stub(content)));
+    done.stubbed++;
   }
 
   // 2. elide the arguments of calls that already ran, oldest first
   for (const [index, next] of slim) {
     if (tokens <= budget) break;
-    messages[index] = next;
-    const size = estimate([next]);
-    tokens += size - sizes[index];
-    sizes[index] = size;
-    result.elided++;
+    replace(index, next);
+    done.elided++;
   }
 
   // 3. then drop what the model has read, oldest first
   for (const index of read) {
     if (tokens <= budget) break;
-    if (text(messages[index]).includes(DROPPED)) continue;
-    replace(index, DROPPED_NOTE);
-    result.dropped++;
+    if (isDropped(text(work[index]))) continue;
+    replace(index, withContent(index, DROPPED_NOTE));
+    done.dropped++;
   }
 
   // 4. only then squeeze what it has not read, biggest first - never to
   //    nothing: the full text stays on disk and the pointer says where
   for (const index of [...unread].sort((a, b) => sizes[b] - sizes[a])) {
     if (tokens <= budget) break;
-    const content = text(messages[index]);
-    if (content.length <= SQUEEZE + 400) continue;
-    replace(index, squeeze(content, scope));
-    result.squeezed++;
+    if (!squeezable(index)) continue;
+    replace(index, withContent(index, squeeze(text(work[index]), scope)));
+    done.squeezed++;
   }
 
-  result.tokens = tokens;
-  result.fits = tokens <= budget;
-  return result;
+  if (tokens > budget) {
+    // The estimate of the floor was a little optimistic. Report the floor
+    // actually reached and leave the transcript alone.
+    return { ...result, floor: tokens };
+  }
+  for (let index = 0; index < work.length; index++) {
+    if (work[index] !== messages[index]) messages[index] = work[index];
+  }
+  return { ...result, ...done, tokens, fits: true };
 }
```

</details>

### 6.2 Compaction and the loop — `src/compact.ts`, `src/agent.ts`

The cut never crosses into the unread exchange, and `changed` replaces the length comparison. In the loop:
- one compaction is tried past the cooldown before refusing;
- the refusal names the real constraint;
- the rewrite is recorded whole in the session log;
- cut-off calls are answered, not run.

<details><summary>Show diff — <code>src/compact.ts, src/agent.ts</code> (+52 / −19)</summary>

```diff
diff --git a/src/agent.ts b/src/agent.ts
index 2f5ca0e..53e88a4 100644
--- a/src/agent.ts
+++ b/src/agent.ts
@@ -14,7 +14,7 @@ import { TOOL_SCHEMAS, toolsFor } from "./tools/index.js";
 import { reminder } from "./context.js";
 import { cap, sweep, settle, fit, estimate } from "./history.js";
 import { compact } from "./compact.js";
-import { approver, asker, execute, peek, type Asker } from "./execute.js";
+import { approver, asker, cutOff, execute, peek, type Asker } from "./execute.js";
 import { blame, observe, type CacheBreak } from "./cache.js";
 import { CancelledError, within, type Role } from "./scope.js";
 
@@ -34,8 +34,12 @@ export interface AgentOptions {
   onChunk?: (chunk: string) => void;
   onCompacted?: (before: number, messages: ChatMessages[]) => void;
   onNote?: (text: string) => void;
-  /** Called after every change to the transcript, so a session log can keep up. */
-  onTranscript?: (messages: ChatMessages[]) => void;
+  /**
+   * Called after every change to the transcript, so a session log can keep up.
+   * `replaced` names a rewrite (compaction) the log must record whole: the
+   * message count alone cannot tell, since one message can replace one.
+   */
+  onTranscript?: (messages: ChatMessages[], replaced?: string) => void;
   onCacheBreak?: (info: CacheBreak) => void;
   onModeChange?: (mode: Mode) => void;
   injectReminder?: boolean;
@@ -180,15 +184,16 @@ export async function runAgent(
 
       // 1. Compaction first: it summarises what it removes, fit() only loses it.
       //    Checked before the request, so no call is paid for and then thrown away.
-      const size = estimate(messages);
-      if (size + fixed > budget && size - compactedAt > config.contextWindow * 0.25) {
+      let compactedNow = false;
+      const tryCompact = async () => {
+        compactedNow = true;
         const before = messages.length;
         try {
           blame(messages, "compaction");
           const done = await compact(messages);
-          if (done.after < before) {
+          if (done.changed) {
             compactions.push({ step, before, after: done.after, cost: done.cost });
-            persist();
+            options.onTranscript?.(messages, "compaction");
             options.onCompacted?.(before, messages);
           }
         } catch (err: any) {
@@ -198,11 +203,21 @@ export async function runAgent(
           options.onNote?.(`compaction failed (${err.message || String(err)}); continuing without it`);
         }
         compactedAt = estimate(messages);
+      };
+      const size = estimate(messages);
+      if (size + fixed > budget && size - compactedAt > config.contextWindow * 0.25) {
+        await tryCompact();
       }
 
       // 2. Last resort. It refuses an unreachable target rather than dropping
-      //    every result on the way to failing anyway, so stop loudly instead.
-      const fitted = fit(messages, budget, fixed);
+      //    every result on the way to failing anyway. Before stopping the turn,
+      //    one compaction the cooldown held back is still better than none.
+      let fitted = fit(messages, budget, fixed);
+      const floorOfPrompt = fixed + estimate([messages[0]]);
+      if (!fitted.fits && !compactedNow && floorOfPrompt <= budget) {
+        await tryCompact();
+        fitted = fit(messages, budget, fixed);
+      }
       if (fitted.stubbed + fitted.elided + fitted.dropped + fitted.squeezed > 0) {
         blame(messages, "fit");
         options.onNote?.(
@@ -212,9 +227,12 @@ export async function runAgent(
       }
       if (!fitted.fits) {
         throw new ContextBudgetError(
-          `This request needs ~${fitted.floor} tokens even with every old tool result dropped, but the budget is ` +
-          `${budget} (CONTEXT_WINDOW=${config.contextWindow} x COMPACT_AT=${config.compactAt}, ~${fixed} of it tool schemas). ` +
-          `Raise CONTEXT_WINDOW or run /compact.`
+          floorOfPrompt > budget
+            ? `The tool schemas and system prompt alone need ~${floorOfPrompt} tokens, more than the ${Math.round(budget)}-token ` +
+              `budget (CONTEXT_WINDOW=${config.contextWindow} x COMPACT_AT=${config.compactAt}). Raise CONTEXT_WINDOW; /compact cannot help.`
+            : `This request needs ~${fitted.floor} tokens even with every old tool result dropped, but the budget is ` +
+              `${Math.round(budget)} (CONTEXT_WINDOW=${config.contextWindow} x COMPACT_AT=${config.compactAt}; ~${fixed} of it ` +
+              `tool schemas and the reminder reserve). Raise CONTEXT_WINDOW or run /compact.`
         );
       }
 
@@ -238,10 +256,11 @@ export async function runAgent(
       }
 
       // Call the LLM with conversation history (+ late injection) and available tools
-      const { message, usage, metrics } = await callLLM(messagesToSend, tools.schemas, {
+      const { message, usage, metrics, finishReason } = await callLLM(messagesToSend, tools.schemas, {
         onChunk: options.onChunk,
         stable: messages.length
       });
+      const truncated = finishReason === "length";
 
       lastUsage = usage;
       lastMetrics = metrics;
@@ -279,6 +298,10 @@ export async function runAgent(
 
       // If no tool calls were requested, the agent is done
       if (!message.toolCalls || message.toolCalls.length === 0) {
+        if (truncated) {
+          finalResponse += "\n\n(the answer was cut off: it hit the output-token limit)";
+          options.onNote?.("the answer hit the output-token limit and is incomplete - say \"continue\" for the rest");
+        }
         if (options.onStepEnd) {
           options.onStepEnd(step, usage);
         }
@@ -309,9 +332,12 @@ export async function runAgent(
         // In pipeline mode the agent's own bash is read-only: anything that
         // would need approval is refused, so edits go through the worker.
         const approve = mode === "pipeline" && toolName === "bash" ? undefined : options.onApprove;
-        const { args, result } = await approver.run(options.onApprove, () =>
-          asker.run(options.onAsk, () => execute(toolCall, { tools: tools.byName, approve }))
-        );
+        const cut = truncated ? cutOff(toolCall) : null;
+        const { args, result } = cut
+          ? { args: {}, result: cut }
+          : await approver.run(options.onApprove, () =>
+              asker.run(options.onAsk, () => execute(toolCall, { tools: tools.byName, approve }))
+            );
 
         // Cap fresh tool result: if oversized, spill to disk and replace with pointer
         const cappedResult = cap(result);
diff --git a/src/compact.ts b/src/compact.ts
index 3aa9101..c2f602d 100644
--- a/src/compact.ts
+++ b/src/compact.ts
@@ -208,6 +208,8 @@ export interface Compaction {
   before: number;
   after: number;
   cost: number;
+  /** The transcript was rewritten. Not the same as after < before: one message can replace one. */
+  changed: boolean;
 }
 
 /**
@@ -222,9 +224,14 @@ export interface Compaction {
 export async function compact(messages: ChatMessages[], force = false): Promise<Compaction> {
   const before = messages.length;
   const budget = force ? 0 : config.contextWindow * config.compactTo;
-  const cut = tailStart(messages, budget);
+  // Never cut into the exchange the model has not read yet: summarising those
+  // results hands it a paraphrase of output it asked for and never saw. If
+  // they are too big to keep whole, fit() squeezes them to a pointer instead.
+  const fresh = live(messages);
+  const unreadFrom = fresh < messages.length ? fresh - 1 : messages.length;
+  const cut = Math.min(tailStart(messages, budget), unreadFrom);
   if (cut <= 1) {
-    return { before, after: before, cost: 0 }; // nothing old enough to be worth summarising
+    return { before, after: before, cost: 0, changed: false }; // nothing old enough to be worth summarising
   }
 
   const old = messages.slice(1, cut);
@@ -252,5 +259,5 @@ export async function compact(messages: ChatMessages[], force = false): Promise<
 
   // In-place update so caller references stay in sync
   messages.splice(0, messages.length, ...kept);
-  return { before, after: messages.length, cost };
+  return { before, after: messages.length, cost, changed: true };
 }
```

</details>

### 6.3 Subagent outcomes — `src/subagent.ts`, `src/tools/orchestrator.ts`

<details><summary>Show diff — <code>src/subagent.ts, src/tools/orchestrator.ts</code> (+122 / −57)</summary>

```diff
diff --git a/src/subagent.ts b/src/subagent.ts
index 0866259..0ae772a 100644
--- a/src/subagent.ts
+++ b/src/subagent.ts
@@ -1,9 +1,9 @@
 import type { Tool } from "./tools/types.js";
-import type { ChatFunctionTool, ChatMessages } from "@openrouter/sdk/models";
+import type { ChatFunctionTool, ChatMessages, ChatToolCall } from "@openrouter/sdk/models";
 import { callLLM, spentSince, tally } from "./llm.js";
 import { cap, fit, sweep, type SpillScope } from "./history.js";
-import { approver, execute, type Gate } from "./execute.js";
-import { current, within, type Role } from "./scope.js";
+import { approver, cutOff, execute, type Gate } from "./execute.js";
+import { CancelledError, current, within, type Role } from "./scope.js";
 import { shortStatus } from "./git.js";
 import { ui } from "./ui.js";
 import { config } from "./config.js";
@@ -25,6 +25,18 @@ export interface SubagentConfig {
   timeoutMs?: number;
 }
 
+/** How a run ended. Only "done" means the text is a finished answer. */
+export type SubagentStatus = "done" | "out_of_turns" | "out_of_context" | "cancelled" | "timeout" | "failed";
+
+export interface SubagentOutcome {
+  status: SubagentStatus;
+  /** What the parent gets back: the report, or partial findings plus the state of the tree. */
+  text: string;
+}
+
+const NOT_RUN = "[not run: the report was already submitted]";
+const CANCELLED = "[cancelled before this ran]";
+
 /**
  * Universal subagent runner with an isolated context window.
  *
@@ -38,8 +50,14 @@ export interface SubagentConfig {
  *    fitted every turn - its context can overflow too, and nobody compacts it.
  * 6. It always reports. Out of turns, out of time, cancelled or crashed, the parent gets what it had
  *    found so far and what the working tree looks like now - never a bare "Tool error".
+ * 7. Cancelled means stopped: once the turn is cancelled or the deadline passes, no further call runs.
  */
 export async function runSubagent(subagentConfig: SubagentConfig): Promise<string> {
+  return (await runSubagentDetailed(subagentConfig)).text;
+}
+
+/** runSubagent, plus how the run ended - so a caller never mistakes partial notes for a result. */
+export async function runSubagentDetailed(subagentConfig: SubagentConfig): Promise<SubagentOutcome> {
   const {
     role,
     taskDescription,
@@ -75,17 +93,63 @@ export async function runSubagent(subagentConfig: SubagentConfig): Promise<strin
   ui.subagent(`${label}: ${taskDescription.length > 400 ? `${taskDescription.slice(0, 400)}...` : taskDescription}`);
   let spinner = ui.working(`${label} working...`);
 
-  const loop = async (): Promise<string> => {
+  /** Run one reply's tool calls. True once `finishOn` has run successfully. */
+  const runCalls = async (calls: ChatToolCall[], truncated: boolean): Promise<boolean> => {
+    let finished = false;
+    for (let index = 0; index < calls.length; index++) {
+      const toolCall = calls[index];
+      if (finished) {
+        // the run is over; answer the remaining calls so the transcript stays valid
+        messages.push({ role: "tool", toolCallId: toolCall.id, content: NOT_RUN });
+        continue;
+      }
+      // A worker used to carry on writing files after the user had cancelled.
+      if (signal.aborted) {
+        for (const pending of calls.slice(index)) {
+          messages.push({ role: "tool", toolCallId: pending.id, content: CANCELLED });
+        }
+        throw signal.reason instanceof Error ? signal.reason : new CancelledError();
+      }
+      spinner.stop();
+      spinner = ui.working(`${label}: running ${toolCall.function.name}...`);
+
+      const cut = truncated ? cutOff(toolCall) : null;
+      const { args, result } = cut ? { args: {}, result: cut } : await execute(toolCall, gate);
+      const capped = cap(result, spills);
+
+      spinner.stop();
+      ui.tool(toolCall.function.name, args, capped, true);
+
+      messages.push({
+        role: "tool",
+        toolCallId: toolCall.id,
+        content: capped
+      });
+
+      if (finishOn && toolCall.function.name === finishOn && !/^(Error|Permission denied|Tool error)/.test(result)) {
+        finished = true;
+        report ||= result;
+      }
+    }
+    return finished;
+  };
+
+  const partial = (why: string): string =>
+    report
+      ? `(${why}, before finishing. Partial findings below - narrow the question and ask again.)\n\n${report}`
+      : `(${why} with nothing to report.)`;
+
+  const loop = async (): Promise<SubagentOutcome> => {
     for (let turn = 1; turn <= maxTurns; turn++) {
       spinner.stop();
       spinner = ui.working(`${label} working (turn ${turn}/${maxTurns})...`);
 
       if (!fit(messages, budget, fixed, spills).fits) {
-        report ||= `(${label} ran out of context window before it could report.)`;
-        break;
+        // Said as what it is - it used to be reported as "stopped after N turns".
+        return { status: "out_of_context", text: partial(`${label} ran out of context window`) };
       }
 
-      const { message, usage } = await callLLM(messages, toolSchemas);
+      const { message, usage, finishReason } = await callLLM(messages, toolSchemas);
 
       if (usage) {
         spinner.stop();
@@ -109,57 +173,46 @@ export async function runSubagent(subagentConfig: SubagentConfig): Promise<strin
 
       // Subagent finished if no tool calls requested
       if (!message.toolCalls || message.toolCalls.length === 0) {
-        return report || `${label} completed with no output.`;
+        return { status: "done", text: report || `${label} completed with no output.` };
       }
 
-      let finished = false;
-      for (const toolCall of message.toolCalls) {
-        if (finished) {
-          // the run is over; answer the remaining calls so the transcript stays valid
-          messages.push({ role: "tool", toolCallId: toolCall.id, content: "[not run: the report was already submitted]" });
-          continue;
-        }
-        spinner.stop();
-        spinner = ui.working(`${label}: running ${toolCall.function.name}...`);
-
-        const { args, result } = await execute(toolCall, gate);
-        const capped = cap(result, spills);
-
-        spinner.stop();
-        ui.tool(toolCall.function.name, args, capped, true);
-
-        messages.push({
-          role: "tool",
-          toolCallId: toolCall.id,
-          content: capped
-        });
-
-        if (finishOn && toolCall.function.name === finishOn && !/^(Error|Permission denied|Tool error)/.test(result)) {
-          finished = true;
-          report ||= result;
-        }
+      if (await runCalls(message.toolCalls, finishReason === "length")) {
+        return { status: "done", text: report };
       }
-      if (finished) return report;
     }
 
     // Out of turns. Ask once more, for the report only: the last thing it
-    // said is usually "let me check one more file", not a finding.
+    // said is usually "let me check one more file", not a finding. A role that
+    // reports through a tool is offered that tool alone and must call it -
+    // told "do not call any tools", the reviewer could never deliver its
+    // verdict, and no verdict counts as changes_requested.
+    const reportTool = finishOn ? toolMap[finishOn]?.schema : undefined;
     messages.push({
       role: "user",
-      content: "You are out of turns. Reply now with your report - what you found, what you changed, what is unfinished. Do not call any tools."
+      content: reportTool
+        ? `You are out of turns. Call ${finishOn} now with what you have found so far. Do not call any other tool.`
+        : "You are out of turns. Reply now with your report - what you found, what you changed, what is unfinished. Do not call any tools."
     });
     try {
       if (fit(messages, budget, fixed, spills).fits) {
-        const { message } = await callLLM(messages, toolSchemas);
+        const { message } = await callLLM(
+          messages,
+          reportTool ? [reportTool] : toolSchemas,
+          reportTool ? { toolChoice: "required" } : {}
+        );
         if (message.content) report = message.content;
+        const calls = (message.toolCalls ?? []).filter((c) => c.function.name === finishOn);
+        if (reportTool && calls.length > 0) {
+          messages.push({ role: "assistant", content: message.content || "", toolCalls: calls } as ChatMessages);
+          if (await runCalls(calls, false)) return { status: "done", text: report };
+        }
       }
-    } catch {
+    } catch (err) {
+      if (signal.aborted) throw err;
       // keep the last thing it managed to say
     }
 
-    return report
-      ? `(stopped after ${maxTurns} turns, before finishing. Partial findings below - narrow the question and ask again.)\n\n${report}`
-      : `(stopped after ${maxTurns} turns with nothing to report.)`;
+    return { status: "out_of_turns", text: partial(`stopped after ${maxTurns} turns`) };
   };
 
   try {
@@ -167,17 +220,22 @@ export async function runSubagent(subagentConfig: SubagentConfig): Promise<strin
   } catch (err: any) {
     // Files the worker already changed stay changed, so the parent needs to
     // know what the tree looks like now, not just that something went wrong.
-    const why = parent?.aborted
-      ? "was cancelled by the user"
-      : deadline.aborted
-        ? `ran out of time (${Math.round(timeoutMs / 1000)}s)`
-        : `failed: ${err?.message || String(err)}`;
-    const status = await shortStatus();
-    return [
-      `(${label} ${why} before finishing.)`,
-      report ? `Last thing it reported:\n${report}` : "",
-      `Working tree now (git status --short):\n${status || "(clean, or not a git repository)"}`
-    ].filter(Boolean).join("\n\n");
+    const status: SubagentStatus = parent?.aborted ? "cancelled" : deadline.aborted ? "timeout" : "failed";
+    const why =
+      status === "cancelled"
+        ? "was cancelled by the user"
+        : status === "timeout"
+          ? `ran out of time (${Math.round(timeoutMs / 1000)}s)`
+          : `failed: ${err?.message || String(err)}`;
+    const tree = await shortStatus();
+    return {
+      status,
+      text: [
+        `(${label} ${why} before finishing.)`,
+        report ? `Last thing it reported:\n${report}` : "",
+        `Working tree now (git status --short):\n${tree || "(clean, or not a git repository)"}`
+      ].filter(Boolean).join("\n\n")
+    };
   } finally {
     spinner.stop();
     sweep(spills);
diff --git a/src/tools/orchestrator.ts b/src/tools/orchestrator.ts
index 0da5ebd..86ecaa7 100644
--- a/src/tools/orchestrator.ts
+++ b/src/tools/orchestrator.ts
@@ -7,7 +7,7 @@ import { writeFileTool } from "./writeFile.js";
 import { stringReplaceTool } from "./stringReplace.js";
 import { readSkillTool } from "./readSkill.js";
 import { grepTool, globTool } from "./search.js";
-import { runSubagent } from "../subagent.js";
+import { runSubagent, runSubagentDetailed } from "../subagent.js";
 import { git, snapshot } from "../git.js";
 import {
   artifactsDir,
@@ -98,7 +98,7 @@ export const planTool: Tool<PlanTaskArgs, string> = {
   execute: async (args) => {
     const goal = args.goal || args.description || JSON.stringify(args);
     const context = args.context ? `\n\nAdditional Context:\n${args.context}` : "";
-    const report = await runSubagent({
+    const outcome = await runSubagentDetailed({
       role: "planner",
       taskDescription: `Create an implementation plan for the following goal:\n${goal}${context}`,
       systemPrompt: getPlannerPrompt(),
@@ -107,9 +107,16 @@ export const planTool: Tool<PlanTaskArgs, string> = {
       label: "planner",
       readOnly: true
     });
-    if (report.startsWith("(planner ")) {
-      return report; // failed or cancelled - nothing worth storing as a plan
+    if (outcome.status !== "done") {
+      // Partial notes are not a plan. Stored, they became the worker's
+      // instructions ("I was still looking at README.md").
+      return (
+        `The planner did not finish (${outcome.status.replace(/_/g, " ")}), so nothing was saved as a plan. ` +
+        "Call plan_task again with a narrower goal, or ask the user.\n\n" +
+        outcome.text
+      );
     }
+    const report = outcome.text;
     const record = savePlan(`# Goal\n${goal}${context}\n\n${report}`);
     return (
       `Plan saved as plan_id "${record.id}" (${path.relative(process.cwd(), record.path)}). ` +
```

</details>

### 6.4 Provider interface and gate — `src/llm.ts`, `src/execute.ts`

<details><summary>Show diff — <code>src/llm.ts, src/execute.ts</code> (+33 / −3)</summary>

```diff
diff --git a/src/execute.ts b/src/execute.ts
index 401a4ca..0139b25 100644
--- a/src/execute.ts
+++ b/src/execute.ts
@@ -51,6 +51,26 @@ export function peek(raw: string | undefined): Record<string, any> {
   }
 }
 
+/**
+ * The reply hit the output-token limit, so its last call is cut off. The
+ * generic "not valid JSON - send the complete call again" made the model
+ * resend the same oversized call until the step limit, paying for the output
+ * each time. Returns the result to record instead of running it, or null if
+ * this call arrived whole.
+ */
+export function cutOff(call: ChatToolCall): string | null {
+  try {
+    JSON.parse(call.function.arguments || "{}");
+    return null;
+  } catch {
+    return (
+      `Error: your reply hit the output-token limit and this ${call.function.name} call was cut off, so nothing was run. ` +
+      "Sending it again will be cut off the same way. Make it smaller: write a long file in parts " +
+      "(write_file with the first part, then str_replace to add the rest), or split the work into several calls."
+    );
+  }
+}
+
 export async function execute(call: ChatToolCall, gate: Gate): Promise<Executed> {
   const name = call.function.name;
 
@@ -77,7 +97,8 @@ export async function execute(call: ChatToolCall, gate: Gate): Promise<Executed>
     };
   }
 
-  const permission = check(name, args);
+  // A caller that cannot ask is read-only: stricter rules, see check().
+  const permission = check(name, args, { strict: !gate.approve });
   const reason = permission.reason || name;
   if (permission.action === "deny") {
     return { args, result: `Permission denied: ${reason} is blocked by security policy.` };
diff --git a/src/llm.ts b/src/llm.ts
index 61255f7..97817c5 100644
--- a/src/llm.ts
+++ b/src/llm.ts
@@ -149,6 +149,8 @@ export interface CallLLMResult {
   message: AssistantMessageResult;
   usage: DetailedUsage | null;
   metrics: TimingMetrics;
+  /** "length" means the reply hit the output limit and its last tool call is cut off. */
+  finishReason: string | null;
 }
 
 export interface CallOptions {
@@ -162,8 +164,12 @@ export interface CallOptions {
    * follows (the late reminder) changes every call and must not be cached.
    */
   stable?: number;
+  /** "required" makes the model call one of `tools` - e.g. the reviewer's last turn. */
+  toolChoice?: "auto" | "required" | "none";
 }
 
+const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || undefined;
+
 const EPHEMERAL = { type: "ephemeral" as const };
 
 /** Anthropic caches only up to an explicit breakpoint; other providers cache on their own. */
@@ -300,7 +306,9 @@ export async function callLLM(
           messages: request.messages,
           tools: request.tools,
           stream: true,
-          provider: config.provider
+          provider: config.provider,
+          ...(opts.toolChoice && request.tools ? { toolChoice: opts.toolChoice } : {}),
+          ...(MAX_OUTPUT_TOKENS ? { maxTokens: MAX_OUTPUT_TOKENS } : {})
         }
       },
       { ...RETRY, signal: abort }
@@ -441,6 +449,7 @@ export async function callLLM(
           : undefined
     },
     usage,
-    metrics
+    metrics,
+    finishReason
   };
 }
```

</details>

### 6.5 Permission hardening — `src/permissions.ts`

<details><summary>Show diff — <code>src/permissions.ts</code> (+118 / −14)</summary>

```diff
diff --git a/src/permissions.ts b/src/permissions.ts
index e5c4d1b..0b32d31 100644
--- a/src/permissions.ts
+++ b/src/permissions.ts
@@ -1,6 +1,7 @@
 import { insideProject, PROJECT_ROOT, shellKind } from "./sandbox.js";
 import { browserTarget, parseBrowserArgs } from "./tools/browser.js";
 import { config } from "./config.js";
+import { isSpill } from "./history.js";
 
 export type PermissionAction = "allow" | "ask" | "deny";
 
@@ -12,7 +13,70 @@ export interface PermissionCheck {
 }
 
 /** Paths whose contents should never reach the model without a human saying so. */
-const SECRETS = /(\.ssh|\.aws|\.gnupg|\.netrc|\bid_(rsa|ed25519|ecdsa)\b|\bcredentials\b|(^|[\s/\\"'=])\.env(\.|\b|$))/i;
+const SECRETS =
+  /(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|\bgh[\\/]hosts\.ya?ml|\bid_(rsa|ed25519|ecdsa)\b|\bcredentials\b|(^|[\s/\\"'=<])\.env(\.|\b|$))/i;
+
+/** Names SECRETS protects, to test shell globs against: `cat .en?` is `cat .env`. */
+const SECRET_NAMES = [".env", ".env.local", ".env.production", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "id_rsa", "id_ed25519", "id_ecdsa"];
+
+/**
+ * The words of a command as the shell sees them once quotes and escapes are
+ * gone - `.e''nv`, `".env"` and `.e\nv` are all `.env` - and whether each one
+ * still holds an unquoted glob character the shell will expand.
+ */
+function words(command: string, posix: boolean): Array<{ word: string; glob: boolean }> {
+  const escape = posix ? "\\" : "`";
+  const out: Array<{ word: string; glob: boolean }> = [];
+  let word = "";
+  let glob = false;
+  let quote: string | null = null;
+  const flush = () => {
+    if (word) out.push({ word, glob });
+    word = "";
+    glob = false;
+  };
+  for (let index = 0; index < command.length; index++) {
+    const char = command[index];
+    if (quote) {
+      if (char === quote) quote = null;
+      else word += char;
+    } else if (char === escape) {
+      word += command[++index] ?? "";
+    } else if (char === '"' || char === "'") {
+      quote = char;
+    } else if (/[\s;&|<>()]/.test(char)) {
+      flush();
+    } else {
+      if (char === "*" || char === "?" || char === "[") glob = true;
+      word += char;
+    }
+  }
+  flush();
+  return out;
+}
+
+function globMatches(pattern: string, name: string): boolean {
+  const regex = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
+  try {
+    return new RegExp(`^${regex}$`, "i").test(name);
+  } catch {
+    return true; // an odd bracket expression: assume the worst
+  }
+}
+
+/**
+ * Could this word, once the shell has expanded it, name a credentials file?
+ * Globs follow the shell's rules: a leading dot has to be written out, and a
+ * pattern of nothing but wildcards (`ls *`, `cat src/*`) aims at no file in
+ * particular - asking about those would make every listing need approval.
+ */
+function touchesSecret({ word, glob }: { word: string; glob: boolean }): boolean {
+  if (SECRETS.test(word)) return true;
+  if (!glob) return false;
+  const base = word.split(/[\\/]/).pop() ?? word;
+  if (!/[^*?]/.test(base.replace(/\[[^\]]*\]/g, ""))) return false;
+  return SECRET_NAMES.some((name) => name.startsWith(".") === base.startsWith(".") && globMatches(base, name));
+}
 
 /**
  * Wildcard matcher supporting * and ?
@@ -109,6 +173,11 @@ export function effects(command: string, posix = shellKind() === "posix"): strin
       quote = char;
     } else if (char === "$" && next === "(") {
       found.add("runs a command substitution");
+      index++;
+    } else if (!posix && char === "(") {
+      // PowerShell evaluates (...) and @(...) anywhere in a command line:
+      // `Get-Content (Remove-Item -Recurse src)` deletes src.
+      found.add("runs a subexpression");
     } else if (posix && char === "`") {
       found.add("runs a command substitution");
     } else if ((char === "<" || char === ">") && next === "(") {
@@ -127,7 +196,9 @@ export function effects(command: string, posix = shellKind() === "posix"): strin
     }
   }
 
-  if (SECRETS.test(command)) found.add("reads or writes a credentials file");
+  if (SECRETS.test(command) || words(command, posix).some(touchesSecret)) {
+    found.add("reads or writes a credentials file");
+  }
   return [...found];
 }
 
@@ -209,19 +280,35 @@ export const BASH_RULES: Array<[string, PermissionAction]> = [
  * Flags that turn an allow-listed reader into a writer.
  */
 const RISKY_FLAGS: RegExp[] = [
-  /^find\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/i,
-  /^git\s+branch\b.*\s(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force)\b/,
+  /^find\b.*\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/i,
+  /^git\s+branch\b.*\s(-d|-D|-m|-M|-c|-C|-f|-u|-t|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--track|--edit-description)\b/,
   /^git\s+(diff|log|show)\b.*\s--output\b/,
-  /^sort\b.*\s(-o|--output)\b/,
-  /^tree\b.*\s-o\b/,
+  /^git\s+diff\b.*\s--no-index\b/, // diffs any two files on disk, outside the project too
+  /^sort\b.*\s(-[a-zA-Z]*o|--o)/, // -o FILE, -oFILE, -uo FILE, and GNU's abbreviations --out=, --outp=...
+  /^tree\b.*\s-o/,
+  /^(rg|ripgrep)\b.*\s--pre\b/, // runs COMMAND on every file it searches
+  /^date\b.*\s(-s|--set)\b/,
   /^(Get-ChildItem|gci|dir|ls)\b.*\benv:/i
 ];
 
+/** `uniq INPUT OUTPUT` writes OUTPUT. */
+function uniqWrites(part: string): boolean {
+  const [command, ...rest] = part.trim().split(/\s+/);
+  return command === "uniq" && rest.filter((arg) => !arg.startsWith("-")).length >= 2;
+}
+
+/**
+ * Allow-listed commands that run the project's own code (conftest.py, test
+ * files). Fine while a human can watch; not for a role that cannot ask, since
+ * write_file needs no approval inside the project and pytest would run it.
+ */
+const RUNS_PROJECT_CODE: RegExp[] = [/^pytest\b/i, /^python3?\s+-m\s+pytest\b/i];
+
 /**
  * Rate every part of a compound command; the strictest verdict wins.
- * Precedence: deny > ask > allow
+ * Precedence: deny > ask > allow. `strict` is for callers that cannot ask.
  */
-export function decide(command: string, posix = shellKind() === "posix"): PermissionAction {
+export function decide(command: string, posix = shellKind() === "posix", strict = false): PermissionAction {
   const verdicts: PermissionAction[] = [];
 
   for (const part of splitCommand(command, posix)) {
@@ -231,7 +318,11 @@ export function decide(command: string, posix = shellKind() === "posix"): Permis
         action = rule;
       }
     }
-    if (action === "allow" && RISKY_FLAGS.some((flag) => flag.test(part.trim()))) {
+    const trimmed = part.trim();
+    if (action === "allow" && (RISKY_FLAGS.some((flag) => flag.test(trimmed)) || uniqWrites(trimmed))) {
+      action = "ask";
+    }
+    if (strict && action === "allow" && RUNS_PROJECT_CODE.some((rule) => rule.test(trimmed))) {
       action = "ask";
     }
     verdicts.push(action);
@@ -297,22 +388,35 @@ function checkBrowser(args: Record<string, any>): PermissionCheck {
 }
 
 /**
- * Return (action, reason). Action is allow, ask or deny.
+ * Return (action, reason). Action is allow, ask or deny. `strict` is set for
+ * callers that cannot ask (read-only subagents, pipeline-mode bash).
  */
-export function check(name: string, args: Record<string, any>): PermissionCheck {
+export function check(name: string, args: Record<string, any>, options: { strict?: boolean } = {}): PermissionCheck {
   if (name === "browser") {
     return checkBrowser(args);
   }
 
-  if ((name === "grep" || name === "glob") && args.path && !insideProject(String(args.path))) {
-    return { action: "ask", reason: `${name} outside ${PROJECT_ROOT}: ${args.path}` };
+  // The harness's own temp files, written for this agent to page through.
+  // They live in the OS temp directory, so the outside-the-project rule used
+  // to ask every time - and refuse read-only roles outright.
+  if ((name === "read_file" || name === "grep") && args.path && isSpill(String(args.path))) {
+    return { action: "allow" };
+  }
+
+  if ((name === "grep" || name === "glob") && args.path) {
+    if (!insideProject(String(args.path))) {
+      return { action: "ask", reason: `${name} outside ${PROJECT_ROOT}: ${args.path}` };
+    }
+    if (SECRETS.test(String(args.path))) {
+      return { action: "ask", reason: `${name} on a credentials file: ${args.path}` };
+    }
   }
 
   if (name === "bash") {
     const cmd = String(args.command || "");
     const why = effects(cmd);
     return {
-      action: decide(cmd),
+      action: decide(cmd, undefined, options.strict),
       reason: why.length > 0 ? `run (${why.join(", ")}): ${cmd}` : `run: ${cmd}`
     };
   }
```

</details>

### 6.6 Process-tree kill — `src/sandbox.ts`

<details><summary>Show diff — <code>src/sandbox.ts</code> (+72 / −48)</summary>

```diff
diff --git a/src/sandbox.ts b/src/sandbox.ts
index 6f2871f..4d8bcc0 100644
--- a/src/sandbox.ts
+++ b/src/sandbox.ts
@@ -1,12 +1,9 @@
 import fs from "node:fs";
 import os from "node:os";
 import path from "node:path";
-import { exec, execSync, spawn } from "node:child_process";
-import { promisify } from "node:util";
+import { execSync, spawn, type ChildProcess } from "node:child_process";
 import { current } from "./scope.js";
 
-const execAsync = promisify(exec);
-
 const OUTPUT_LIMIT = 10 * 1024 * 1024;
 
 /**
@@ -162,6 +159,25 @@ export interface RunResult {
   code: number | null;
 }
 
+/**
+ * Stop a command and everything it started. Killing just the shell left its
+ * children running on Windows - a timed-out `npm test` kept its node workers,
+ * a cancelled dev server kept its port.
+ */
+function killTree(child: ChildProcess): void {
+  if (child.pid == null || child.exitCode != null) return;
+  if (process.platform === "win32") {
+    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
+      .on("error", () => child.kill());
+    return;
+  }
+  try {
+    process.kill(-child.pid, "SIGKILL"); // the process group spawn() gave it
+  } catch {
+    child.kill("SIGKILL");
+  }
+}
+
 /**
  * Runs a command within project boundary, sandboxed when the OS lets us.
  * Rejects (like exec) on a non-zero exit, a timeout, or runaway output.
@@ -170,53 +186,61 @@ export async function run(command: string, timeout = 60000): Promise<RunResult>
   const sandboxed = wrap(command);
   // Ctrl+C or a subagent's time limit kills the command, not just the wait for it.
   const signal = current().signal;
-
-  if (sandboxed) {
-    return new Promise((resolve, reject) => {
-      const child = spawn(sandboxed[0], sandboxed.slice(1), {
-        cwd: PROJECT_ROOT,
-        timeout,
-        env: childEnv(),
-        signal
-      });
-
-      let stdout = "";
-      let stderr = "";
-      const collect = (target: "stdout" | "stderr") => (data: Buffer) => {
-        if (target === "stdout") stdout += data.toString();
-        else stderr += data.toString();
-        if (stdout.length + stderr.length > OUTPUT_LIMIT) child.kill();
-      };
-      child.stdout.on("data", collect("stdout"));
-      child.stderr.on("data", collect("stderr"));
-
-      child.on("close", (code, signal) => {
-        if (code === 0) return resolve({ stdout, stderr, code });
-        reject(Object.assign(new Error(`Command failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`), {
-          stdout, stderr, code, signal, killed: signal != null
-        }));
-      });
-
-      child.on("error", (err) => {
-        reject(err);
-      });
-    });
-  }
-
-  // Windows / default execution
   const shell =
     process.platform === "win32"
       ? windowsBash() || "powershell.exe"
       : process.env.SHELL || "/bin/sh";
-
-  const { stdout, stderr } = await execAsync(command, {
-    cwd: PROJECT_ROOT,
-    maxBuffer: OUTPUT_LIMIT,
-    timeout,
-    shell,
-    env: childEnv(),
-    windowsHide: true,
-    signal
+  const [file, args] = sandboxed ? [sandboxed[0], sandboxed.slice(1)] : [shell, ["-c", command]];
+
+  return new Promise((resolve, reject) => {
+    const child = spawn(file, args, {
+      cwd: PROJECT_ROOT,
+      env: childEnv(),
+      windowsHide: true,
+      detached: process.platform !== "win32" // its own process group, so killTree reaches its children
+    });
+    // Nothing is ever typed into a command: a bare `cat` gets EOF, not a 60s wait.
+    child.stdin?.end();
+
+    let stdout = "";
+    let stderr = "";
+    let stopped: "timeout" | "cancel" | "output" | null = null;
+    const stop = (why: NonNullable<typeof stopped>) => {
+      if (stopped) return;
+      stopped = why;
+      killTree(child);
+    };
+    const timer = setTimeout(() => stop("timeout"), timeout);
+    const onAbort = () => stop("cancel");
+    if (signal?.aborted) onAbort();
+    else signal?.addEventListener("abort", onAbort, { once: true });
+
+    const collect = (target: "stdout" | "stderr") => (data: Buffer) => {
+      if (target === "stdout") stdout += data.toString();
+      else stderr += data.toString();
+      if (stdout.length + stderr.length > OUTPUT_LIMIT) stop("output");
+    };
+    child.stdout?.on("data", collect("stdout"));
+    child.stderr?.on("data", collect("stderr"));
+
+    const settle = () => {
+      clearTimeout(timer);
+      signal?.removeEventListener("abort", onAbort);
+    };
+    child.on("close", (code, killedBy) => {
+      settle();
+      if (stopped === "cancel") {
+        return reject(Object.assign(new Error("cancelled"), { name: "AbortError", stdout, stderr }));
+      }
+      if (code === 0 && !stopped) return resolve({ stdout, stderr, code });
+      const how = stopped ? `${stopped === "timeout" ? "a timeout" : "too much output"}` : killedBy ? `signal ${killedBy}` : `exit code ${code}`;
+      reject(Object.assign(new Error(`Command failed with ${how}`), {
+        stdout, stderr, code, signal: killedBy ?? (stopped ? "SIGTERM" : null), killed: stopped != null || killedBy != null
+      }));
+    });
+    child.on("error", (err) => {
+      settle();
+      reject(err);
+    });
   });
-  return { stdout, stderr, code: 0 };
 }
```

</details>

### 6.7 Small fixes — `src/tools/readFile.ts`, `src/session.ts`, `src/index.ts`, `tests/helpers/mock.ts`

<details><summary>Show diff — <code>src/tools/readFile.ts, src/session.ts, src/index.ts, tests/helpers/mock.ts</code> (+52 / −10)</summary>

```diff
diff --git a/src/index.ts b/src/index.ts
index 6bc1455..1f9c6dd 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -16,7 +16,7 @@ import { settle, sweep, HANDOFF_OPENING } from "./history.js";
 import { usesBreakpoints, type Spend } from "./llm.js";
 import { blame, forget } from "./cache.js";
 import { CancelledError } from "./scope.js";
-import { Session, legacyTranscript, listSessions, load, sessionDir } from "./session.js";
+import { Session, legacyTranscript, listSessions, load, resumable, sessionDir } from "./session.js";
 
 const HELP = `Commands:
     /clear      - Start a new session (history, todos and plans cleared, browser closed)
@@ -100,6 +100,22 @@ ui.onInterrupt = () => {
   cancelTurn();
 };
 
+/**
+ * Keep the session log in step. A log that cannot be written (disk full, a
+ * file locked by a virus scanner) must not take the turn down with it.
+ */
+let logBroken = false;
+function record(messages: ChatMessages[], replaced?: string): void {
+  try {
+    if (replaced) session.replace(messages, replaced);
+    else session.sync(messages);
+    logBroken = false;
+  } catch (err: any) {
+    if (!logBroken) ui.note(`session log not updated (${err.message || String(err)}); the turn carries on`);
+    logBroken = true;
+  }
+}
+
 function freshTranscript(): ChatMessages[] {
   return [{ role: "system", content: getSystemPrompt(mode) }];
 }
@@ -130,7 +146,7 @@ async function runTurn(promptText: string): Promise<void> {
       messages: sessionMessages,
       mode,
       signal: turn.signal,
-      onTranscript: (messages) => session.sync(messages),
+      onTranscript: record,
       onChunk: streaming
         ? (chunk) => {
             spinner.stop();
@@ -285,7 +301,7 @@ async function rewind(): Promise<void> {
 }
 
 async function switchSession(): Promise<void> {
-  const sessions = listSessions().filter((s) => s.file !== session.file);
+  const sessions = listSessions().filter((s) => s.file !== session.file && s.firstRequest.trim());
   if (sessions.length === 0) {
     ui.note("No other sessions for this project.");
     return;
@@ -356,10 +372,10 @@ async function command(input: string): Promise<"done" | "exit" | "prompt"> {
       try {
         blame(sessionMessages, "compaction");
         // forced: works on a short transcript too, keeping only the newest exchange verbatim
-        await compact(sessionMessages, true);
+        const done = await compact(sessionMessages, true);
         spinner.stop();
-        if (sessionMessages.length < before) {
-          session.replace(sessionMessages, "compaction");
+        if (done.changed) {
+          record(sessionMessages, "compaction");
           ui.compacted(before, sessionMessages);
         } else {
           ui.note("Nothing to compact yet.");
@@ -412,7 +428,7 @@ async function main() {
   const warning = budgetWarning(sessionMessages[0].content as string);
   if (warning) ui.note(`warning: ${warning}`);
 
-  const latest = isResume ? listSessions().find((s) => s.messages > 0) : undefined;
+  const latest = isResume ? resumable() : undefined;
   if (latest) {
     // continue the old log rather than opening a new one
     sessionMessages = adopt(load(latest.file).messages);
diff --git a/src/session.ts b/src/session.ts
index 1a08fb0..cd72c3d 100644
--- a/src/session.ts
+++ b/src/session.ts
@@ -92,6 +92,15 @@ export interface SessionInfo {
   firstRequest: string;
 }
 
+/**
+ * The session --resume continues: the newest one with a request in it. Every
+ * launch opens a log, so the newest is often just a system prompt from a
+ * start that was quit at once.
+ */
+export function resumable(dir = sessionDir()): SessionInfo | undefined {
+  return listSessions(dir).find((s) => s.firstRequest.trim());
+}
+
 /** This project's sessions, newest first. */
 export function listSessions(dir = sessionDir()): SessionInfo[] {
   if (!fs.existsSync(dir)) return [];
@@ -165,8 +174,8 @@ export class Session {
     }
     for (let index = this.written; index < messages.length; index++) {
       this.append({ type: "message", message: messages[index] });
+      this.written = index + 1; // a failed write is retried next time, not duplicated
     }
-    this.written = messages.length;
   }
 
   replace(messages: ChatMessages[], reason: string): void {
diff --git a/src/tools/readFile.ts b/src/tools/readFile.ts
index b5ef7a3..00067e5 100644
--- a/src/tools/readFile.ts
+++ b/src/tools/readFile.ts
@@ -2,6 +2,7 @@ import fs from "node:fs/promises";
 import path from "node:path";
 import type { Tool } from "./types.js";
 import { noteRead } from "../context.js";
+import { CAP } from "../history.js";
 
 export interface ReadFileArgs {
   path: string;
@@ -11,6 +12,7 @@ export interface ReadFileArgs {
 
 const WHOLE_FILE_LIMIT = 2 * 1024 * 1024; // bytes read without offset/limit
 const PAGED_FILE_LIMIT = 64 * 1024 * 1024; // bytes read at all
+const PAGE_CHARS = Math.floor(CAP * 0.9); // a whole read longer than this comes back as its first page
 
 function numbered(lines: string[], first: number): string {
   return lines.map((line, i) => `${first + i}\t${line}`).join("\n");
@@ -84,7 +86,21 @@ export const readFileTool: Tool<ReadFileArgs, string> = {
         return header + numbered(selected, start);
       }
 
-      return numbered(lines, 1);
+      // Too long for the tool cap: hand back the first page and say how to go
+      // on. Capped instead, the numbered text was spilled to a temp file, and
+      // paging that with read_file numbered every line a second time.
+      const whole = numbered(lines, 1);
+      if (whole.length <= PAGE_CHARS) return whole;
+      let end = 0;
+      for (let size = 0; end < lines.length && size + lines[end].length + 8 <= PAGE_CHARS; end++) {
+        size += lines[end].length + 8;
+      }
+      end = Math.max(end, 1);
+      return (
+        `[Lines 1 to ${end} of ${lines.length} - too long to show at once. ` +
+        `Continue with offset=${end + 1}, or grep for what you need.]\n` +
+        numbered(lines.slice(0, end), 1)
+      );
     } catch (err: any) {
       return `Error reading file "${targetPath}": ${err.message || String(err)}`;
     }
diff --git a/tests/helpers/mock.ts b/tests/helpers/mock.ts
index b0795b3..8e31867 100644
--- a/tests/helpers/mock.ts
+++ b/tests/helpers/mock.ts
@@ -21,6 +21,7 @@ export interface MockTurn {
   omitIndex?: boolean; // some upstreams omit tool_call.index
   reasoningDetails?: any[]; // streamed as reasoning_details, split across two chunks
   delayMs?: number; // wait before answering; honours the request's abort signal
+  finishReason?: string; // override the final finish_reason, e.g. "length"
 }
 
 export type Script = (body: any, callIndex: number) => MockTurn | Promise<MockTurn>;
@@ -96,7 +97,7 @@ export function install() {
     const promptTokens = turn.promptTokens ?? Math.ceil(bodyText.length / 4);
     chunks.push({
       ...base,
-      choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop" }],
+      choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop") }],
       usage: {
         prompt_tokens: promptTokens,
         completion_tokens: 50,
```

</details>

The ten regression tests (`tests/regressions.test.ts`, 212 lines) are in the patch file. Each is named after its finding (`F-CTX-1`, `F-CMP-1`, `F-SEC-1`, `F-TOOL-1`, `F-SES-1`, `F-SUB-1`, `F-SUB-2`, `F-SUB-3`, `F-LLM-1`, `F-RUN-1`) and drives the real code through the scripted mock.

---

## Appendix A — Evidence index (before / after the patch)

Run with `npx tsx docs/audit/v2/<probe>.mts`. Set `HARNESS_ROOT=<path>` to point a probe at another checkout, such as one with the patch applied.

| ID | What | Probe | Before (`74416fa`) | After (patch) |
|---|---|---|---|---|
| S-1 | Permission decisions | `p1-permissions` | 15/15 POSIX + 3/3 PowerShell + `grep .env` → **allow** | 13/15 + 3/3 + `grep .env` → ask; residual `grep -r`, `pytest` (with a human) |
| S-2 | Bypasses executed through the read-only gate | `p2-gate` | 3 files overwritten (`sort --out`, `uniq`, `find -fprint0`); key read via `cat <.env`, `cat .en?`, `grep` tool | All refused; files intact |
| C-1a | `strip()` on a read of `src/history.ts` | `p3-context` | 0 shrunk (10,247 chars kept) | 1 shrunk → 377 chars |
| C-1b | `fit()` with a marker-quoting result | `p3-context` | `fits=false`, floor *391*, 3,142 > 3,131, **transcript modified** | `fits=true` at 1,965 tokens |
| C-2 | Paging a long `read_file` | `p3-context`, [RL] | Capped and spilled; paging gives `105\t105\t…` | `[Lines 1 to 119 of 199 - … Continue with offset=120]`, no spill |
| C-3 | `estimate()` by script | `p3-context` | 900 English chars → 232; 820 Cyrillic → 212; 260 Chinese → 72 | unchanged (proposal P1-3) |
| C-4 | Compaction during a 10-file parallel read | `p7-compaction-unread` | Cut 13/13 → `[system, user]`, **0/10 results visible** | 10/10 kept |
| L-1 | Planner out of turns | `p4-loop` | Stored plan: *"…I was still looking at README.md."* | *"did not finish (out of turns), nothing was saved"*; no plan |
| L-2 | Reviewer out of turns | `p5-reviewer` | Last call offered 6 tools, no `tool_choice` → `CHANGES_REQUESTED` / "did not submit a verdict" | Offered `[submit_review]`, `tool_choice=required` → `APPROVED`, 0 reworks |
| L-3 | Ctrl+C during the worker's first command | `p4-loop` | The queued `write_file` **ran** | Did not run |
| L-4 | Pipeline turn, then a plain turn | `p4-loop` | `tool set changed` at step 3 and at the next turn's step 1, 0 % reused | unchanged (proposal P1-1) |
| L-5 | `/compact` on 3 messages | `p4-loop` | Summariser paid, handoff written, "Nothing to compact yet.", not logged | Logged and shown |
| L-6 | `finish_reason=length` | `p6-truncation` | "…not valid JSON … send the complete call again" × 6 steps; 49,152 output tokens (×10 at `MAX_STEPS=60`) | "…hit the output-token limit … cut off … write a long file in parts…" |
| L-7 | `--resume` after an empty launch | `p4-loop` | Picks the **empty** session | Picks the session with real work |
| L-8 | Read-only role pages its spill file | `p4-loop` | `Permission denied: read_file outside …` | Readable |
| R-1 | `grep /(x+x+)+y/` | `p8-runtime` | 70 → 264 ms from 24 → 26 chars (2,525 ms cold); **0 event-loop ticks** | unchanged (proposal P0-10) |
| R-2 | Timed-out command with a child | `p8-runtime` | Child **still running** | Child gone |
| B-1 | Fixed overhead | `p9-budget` | ~3,101 tokens/request; step 1 refused below 3,666; warning below ~7,300 | unchanged; message corrected |
| B-2 | Calibration against billed steps | `p9-budget` | Provider / estimate = 1.01–1.13 (n = 9); $0.300 / $0.006 / $1.200 per M | — |
| RL | Real post-roadmap logs | — | 5 logs (2 end at the user's message with no reply and no turn record); 3 turns; reuse 95–99 %/step; spill read needed approval; double numbering | — |
| V | First audit's scenarios A, A2, D, E, G, H, I, J | `docs/audit/verification/verify_loop.ts` | All hold (A now refuses at step 1) | All hold |
| T | Patch verification | — | 42/42 tests | `git apply --check` clean on a pristine clone; `tsc` + `oxlint` clean; **52/52** |

## Appendix B — Status of the first audit's roadmap

| First-audit item | Status at `74416fa` | Note |
|---|---|---|
| P0-1 fail-safe `fit()` | ✅ holds in all replays | Fooled by marker text [C-1]; fixed in v2 |
| P0-2 compaction before the call, cooldown, non-fatal | ✅ | Can swallow the live exchange [C-4]; fixed in v2 |
| P0-3 pinned requests, `$`-safe, labelled note | ✅ | [V-J] |
| P0-4 anchored `locked()` | ✅ | unit test |
| P0-5 shared gate for subagents, own spills, subagent `fit()` | ✅ | The gate itself leaks [S-1] |
| P0-6 invalid JSON, step cap | ✅ | [V-D] [V-E] |
| P0-7 sandbox fixes (ESM, `/dev/null`, realpath, key scrub) | ✅ by reading | Windows still has none |
| P0-8 the 13 permission bypasses | ✅ those 13 | 19 new ones [S-1] |
| P0-9 `str_replace` literal + CRLF | ✅ | test |
| P0-10 Windows shell | ✅ | Git Bash detected here |
| P0-11 provider errors | ✅ | [V-I]; back-off not abortable |
| P0-12 full cost accounting | ✅ | [V-A2] |
| P0-13 provider routing | ✅ | `PROVIDER_ONLY` |
| P0-14 tracked tests | ✅ | 42 tests, CI |
| Phase 2: structured verdict, bounded rework | ✅ happy path | Exhaustion [L-2] |
| Phase 2: plans by reference, review baseline | ✅ | Planner exhaustion [L-1] |
| Phase 2: subagent failure semantics, timeouts | ⚠️ | Cancel ignored [L-3]; out of context mislabelled |
| Phase 2: enforced pipeline mode | ✅ | Cache cost [L-4] |
| Phase 2: cache telemetry, Anthropic breakpoints, strip threshold, argument elision | ✅ | |
| Phase 2: crash-safe sessions, `/sessions`, `/rewind` | ✅ | `--resume` picks empty logs [L-7] |
| Phase 2: Ctrl+C cancels the turn | ⚠️ | Main loop yes; subagents [L-3]; grandchildren [R-2] |
| Phase 2: reasoning round-trip, `context.ts` hygiene, browser gating | ✅ | |
| Phase 3: input, visibility, telemetry, `ask_user`, `grep`/`glob`, numbered `read_file`, CI, lint, dead code | ✅ / ⚠️ | ReDoS [R-1]; double numbering [C-2]; untyped tests; 3 new dead exports |

## Appendix C — Reproducing this audit

```bash
npm run check
```

```bash
npx tsx docs/audit/v2/p1-permissions.mts
```

```bash
npx tsx docs/audit/v2/p4-loop.mts
```

```bash
cd docs/audit/verification && npx tsx verify_loop.ts A2
```

The probes:
- import the checkout's real modules;
- set a fake API key before any import, and replace `fetch` wherever an LLM is involved;
- run commands only inside throwaway directories they create and delete.

`p9-budget` reads this project's recorded runs from `~/.agents/sessions/<project>/runs` and prints nothing from them except token counts and prices.
