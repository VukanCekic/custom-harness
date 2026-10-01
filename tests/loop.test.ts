/**
 * The real agent loop, subagents, git snapshots and session log, driven by a
 * scripted mock LLM (globalThis.fetch is replaced - nothing leaves the
 * machine). Runs in a throwaway git repository.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "harness-loop-"));
execSync("git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "README.md"), "# demo\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);

process.env.OPENROUTER_API_KEY = "sk-or-mock-never-sent";
process.env.SESSION_DIR = path.join(WORK, "..", `${path.basename(WORK)}-sessions`);
process.env.SUBAGENT_TIMEOUT_MS = "1500";
process.env.STRIP_AFTER = "0"; // strip every turn, so the cache telemetry has something to report
delete process.env.MODEL;
delete process.env.PROVIDER_ONLY;

const mock = await import("./helpers/mock.js");
mock.install();
const { runAgent } = await import("../src/agent.js");
const { ledger } = await import("../src/llm.js");
const { resetPipeline } = await import("../src/pipeline.js");
const { Session, load } = await import("../src/session.js");
const context = await import("../src/context.js");
const { config } = await import("../src/config.js");

type Role = "main" | "planner" | "worker" | "reviewer" | "researcher" | "summarizer" | "unknown";
function roleOf(body: any): Role {
  const sys = String(body.messages?.[0]?.content || "").trimStart();
  if (sys.startsWith("You are a coding agent")) return "main";
  if (sys.startsWith("You are compacting the transcript")) return "summarizer";
  if (sys.startsWith("You are a research subagent")) return "researcher";
  if (sys.startsWith("You are a software architect and planning subagent")) return "planner";
  if (sys.startsWith("You are a software engineering worker subagent")) return "worker";
  if (sys.startsWith("You are a rigorous code reviewer subagent")) return "reviewer";
  return "unknown";
}
const tc = (name: string, args: object) => ({ name, arguments: JSON.stringify(args) });
const toolNames = (body: any): string[] => (body.tools || []).map((t: any) => t.function.name);
/** The newest message the model is answering - skipping the main loop's late <env> reminder. */
const newest = (body: any): any => {
  const msgs = body.messages || [];
  const last = msgs.at(-1);
  return typeof last?.content === "string" && last.content.startsWith("<env>") ? msgs.at(-2) : last;
};
const byRole = (role: Role) => mock.requests.filter((b) => roleOf(b) === role);

/** Every assistant tool call has a result right after it. */
function wellFormed(messages: any[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].toolCalls || [];
    const ids = new Set(messages.slice(i + 1, i + 1 + calls.length).map((m: any) => m.toolCallId));
    if (!calls.every((c: any) => ids.has(c.id))) return false;
  }
  return true;
}

beforeEach(() => {
  mock.reset();
  resetPipeline();
});

test("pipeline: plan by reference, worker edits, reviewer sees new files, structured rework", async () => {
  const turns: Record<string, number> = {};
  mock.setScript((body) => {
    const role = roleOf(body);
    const k = (turns[role] = (turns[role] || 0) + 1);
    const last = String(newest(body)?.content ?? "");
    if (role === "planner") return { content: "## Steps\n1. Create lib/new.ts exporting ok().\n## Acceptance Criteria\n- lib/new.ts exists" };
    if (role === "worker") {
      if (body.messages.length === 2) return { content: "", toolCalls: [tc("write_file", { path: "lib/new.ts", content: `export const ok = () => ${k};\n` })] };
      return { content: "Created lib/new.ts" };
    }
    if (role === "reviewer") {
      const verdict = turns.reviewer === 1
        ? { verdict: "changes_requested", summary: "Needs a test.", issues: [{ file: "lib/new.ts", line: 1, problem: "no unit test", fix: "add lib/new.test.ts" }] }
        : { verdict: "approved", summary: "Looks good." };
      return { content: "", toolCalls: [tc("submit_review", verdict)] };
    }
    // main agent
    if (k === 1) return { content: "Planning.", toolCalls: [tc("plan_task", { goal: "Add lib/new.ts. Do not touch src/." })] };
    if (k === 2) {
      const id = last.match(/plan_id "([^"]+)"/)?.[1];
      return { content: "", toolCalls: [tc("work_task", { plan_id: id })] };
    }
    if (k === 3) return { content: "", toolCalls: [tc("review_task", {})] };
    if (k === 4) return { content: "", toolCalls: [tc("work_task", {})] };
    if (k === 5) return { content: "", toolCalls: [tc("review_task", {})] };
    return { content: "All done." };
  });

  const result = await runAgent("Build lib/new.ts", { onApprove: async () => true });
  assert.equal(result.finalResponse, "All done.");

  const main = byRole("main");
  assert.ok(toolNames(main[0]).includes("write_file"), "before the pipeline the agent can edit");
  assert.ok(!toolNames(main[1]).includes("write_file"), "after plan_task the agent is restricted to coordination");
  assert.ok(toolNames(main[1]).includes("work_task"));

  const [firstWork, secondWork] = byRole("worker").filter((b) => b.messages.length === 2);
  assert.match(firstWork.messages[1].content, /Create lib\/new\.ts exporting ok/, "the worker gets the stored plan, not a copy from the main agent");
  assert.match(secondWork.messages[1].content, /rework 1 of 2[\s\S]*no unit test/, "the reviewer's issues reach the worker automatically");

  const [firstReview] = byRole("reviewer").filter((b) => b.messages.length === 2);
  const reviewTask = firstReview.messages[1].content as string;
  assert.match(reviewTask, /new and untracked files included/);
  assert.match(reviewTask, /lib\/new\.ts/, "the diff stat shows a file git diff alone would miss");
  assert.ok(toolNames(firstReview).includes("submit_review"));

  const results = result.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
  assert.ok(results.some((r) => r.startsWith("VERDICT: CHANGES_REQUESTED")));
  assert.ok(results.some((r) => r.startsWith("VERDICT: APPROVED")));
  assert.equal(result.mode, "pipeline");
  for (const role of ["main", "planner", "worker", "reviewer"] as const) {
    assert.ok(result.costByRole[role]?.calls, `cost is attributed to ${role}`);
  }
  assert.ok(Math.abs(result.totalCost - Object.values(result.costByRole).reduce((s, r) => s + (r?.cost ?? 0), 0)) < 1e-9);
  assert.ok(result.stepUsage.length === main.length, "usage is recorded for every main-loop step");
  assert.ok(fs.readFileSync(path.join(WORK, ".agents", "artifacts", ".gitignore"), "utf-8").includes("*"));
  assert.ok(!execSync("git status --short", { encoding: "utf-8" }).includes(".agents"), "artifacts stay out of git status");
});

test("pipeline: the rework loop is bounded in code", async () => {
  let k = 0;
  mock.setScript((body) => {
    const role = roleOf(body);
    if (role === "planner") return { content: "Plan: do X." };
    if (role === "worker") return { content: "did X" };
    if (role === "reviewer") {
      return { content: "", toolCalls: [tc("submit_review", { verdict: "changes_requested", summary: "no", issues: [{ problem: "still wrong" }] })] };
    }
    k++;
    if (k === 1) return { content: "", toolCalls: [tc("plan_task", { goal: "X" })] };
    if (k <= 9) return { content: "", toolCalls: [tc(k % 2 === 0 ? "work_task" : "review_task", {})] };
    return { content: "Reporting to the user." };
  });
  const result = await runAgent("Do X", { onApprove: async () => true });
  const workerRuns = byRole("worker").filter((b) => b.messages.length === 2).length;
  assert.equal(workerRuns, 1 + config.maxRework, "first attempt plus MAX_REWORK reworks, then no more");
  const results = result.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
  assert.ok(results.some((r) => r.startsWith("Rework limit reached")));
});

test("cancelling mid-turn leaves every tool call answered and stops calling the model", async () => {
  const controller = new AbortController();
  mock.setScript(() => ({ content: "", toolCalls: [tc("bash", { command: "echo one" }), tc("bash", { command: "echo two" })] }));
  const result = await runAgent("run two commands", {
    signal: controller.signal,
    onApprove: async () => true,
    onToolCall: () => controller.abort(new (class extends Error { name = "CancelledError"; })())
  });
  assert.equal(result.cancelled, true);
  assert.equal(mock.requests.length, 1, "no request after the cancel");
  assert.ok(wellFormed(result.messages), "the transcript stays valid for the next turn");
  const tools = result.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
  assert.equal(tools.length, 2);
  assert.match(tools[1], /cancelled by user/);
});

test("cancelling while the model is streaming returns promptly", async () => {
  const controller = new AbortController();
  mock.setScript(() => ({ content: "slow", delayMs: 10_000 }));
  setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  const result = await runAgent("hello", { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started < 5_000, "did not wait for the slow response");
  assert.ok(wellFormed(result.messages));
});

test("a subagent that runs out of time reports partial results and the working tree", async () => {
  mock.setScript((body) => {
    if (roleOf(body) === "researcher") return { content: "never", delayMs: 10_000 };
    if (newest(body)?.role === "tool") return { content: "ok" };
    return { content: "", toolCalls: [tc("task", { description: "Where is X?" })] };
  });
  fs.writeFileSync(path.join(WORK, "dirty.txt"), "x");
  const result = await runAgent("explore", {});
  const report = String(result.messages.find((m: any) => m.role === "tool")?.content);
  assert.match(report, /ran out of time/);
  assert.match(report, /git status --short[\s\S]*dirty\.txt/);
  fs.rmSync(path.join(WORK, "dirty.txt"));
});

test("reasoning details are sent back during the tool loop", async () => {
  let k = 0;
  mock.setScript(() => {
    k++;
    return k === 1
      ? { content: "", reasoningDetails: [{ type: "reasoning.text", text: "I should list files." }], toolCalls: [tc("bash", { command: "echo hi" })] }
      : { content: "done" };
  });
  await runAgent("list", {});
  const second = mock.requests[1];
  const assistant = second.messages.find((m: any) => m.role === "assistant");
  assert.equal(assistant.reasoning_details?.[0]?.text, "I should list files.", "chunks merged and round-tripped");
});

test("ask_user reaches the human and the answer comes back", async () => {
  let asked = "";
  mock.setScript((body) =>
    newest(body)?.role === "tool"
      ? { content: "Using blue." }
      : { content: "", toolCalls: [tc("ask_user", { question: "Which colour?", choices: ["red", "blue"] })] }
  );
  const result = await runAgent("paint it", { onAsk: async (q) => ((asked = q), "blue") });
  assert.equal(asked, "Which colour?");
  assert.match(String(result.messages.find((m: any) => m.role === "tool")?.content), /The user answered: blue/);
});

test("cache breaks are attributed; the session log is crash-safe and rewindable", async () => {
  mock.setScript((body) =>
    newest(body)?.role === "tool"
      ? { content: "done" }
      : { content: "", toolCalls: [tc("bash", { command: "node -e \"console.log('y'.repeat(2000))\"" })] }
  );
  const session = Session.create();
  const messages: any[] = [{ role: "system", content: "You are a coding agent." }];
  const sync = (m: any[]) => session.sync(m);
  await runAgent("first", { messages, onTranscript: sync, onApprove: async () => true });
  const second = await runAgent("second", { messages, onTranscript: sync, onApprove: async () => true });
  assert.ok(second.cacheBreaks.some((b) => b.reason === "strip"), JSON.stringify(second.cacheBreaks));

  const loaded = load(session.file);
  assert.equal(loaded.messages.length, messages.length, "every message was appended as it happened");
  fs.appendFileSync(session.file, '{"type":"message","message":{"role":"user","con');
  const torn = load(session.file);
  assert.equal(torn.skipped, 1, "a half-written last line is skipped");
  assert.equal(torn.messages.length, messages.length);

  const resumed = Session.resume(session.file, torn.messages); // what --resume does after a crash
  resumed.rewind(3);
  assert.equal(load(session.file).messages.length, 3, "a record written after the torn line is not lost");
  assert.ok(!session.file.startsWith(WORK + path.sep), "the log lives outside the project");
});

test("the agent's own writes are not reported back as outside changes", async () => {
  context.resetContextState();
  const { writeFileTool } = await import("../src/tools/writeFile.js");
  await writeFileTool.execute({ path: "mine.txt", content: "agent wrote this\n" });
  assert.equal(await context.changesNote(), "", "own write: no 'read it again' note");
  fs.writeFileSync(path.join(WORK, "mine.txt"), "someone else changed it\n");
  assert.match(await context.changesNote(), /mine\.txt/, "a change by someone else is reported");
  assert.equal(await context.changesNote(), "", "and only once");
  await (await import("../src/tools/readFile.js")).readFileTool.execute({ path: "README.md" });
  fs.writeFileSync(path.join(WORK, "README.md"), "# changed\n");
  assert.match(context.staleNote(), /README\.md/);
  assert.equal(context.staleNote(), "", "the stale note is shown once per change");
});

test("the ledger counts every call", () => {
  assert.ok(ledger.calls >= mock.requests.length);
});
