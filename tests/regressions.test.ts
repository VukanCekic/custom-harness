/**
 * Regressions found by the second audit (docs/codebase_audit_and_proposals.md).
 * Each test is named after the finding it pins. The loop tests drive the real
 * agent against the scripted mock in a throwaway git repository.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "harness-regress-"));
execSync("git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "README.md"), "# demo\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);

process.env.OPENROUTER_API_KEY = "sk-or-mock-never-sent";
process.env.SESSION_DIR = path.join(WORK, "..", `${path.basename(WORK)}-sessions`);
process.env.STRIP_AFTER = "0.99";
delete process.env.MODEL;
delete process.env.PROVIDER_ONLY;

const mock = await import("./helpers/mock.js");
mock.install();
const { runAgent } = await import("../src/agent.js");
const { compact } = await import("../src/compact.js");
const history = await import("../src/history.js");
const { decide, check } = await import("../src/permissions.js");
const { readFileTool } = await import("../src/tools/readFile.js");
const { getPlan, resetPipeline } = await import("../src/pipeline.js");
const { Session, resumable } = await import("../src/session.js");
const { run } = await import("../src/sandbox.js");
const { CancelledError } = await import("../src/scope.js");

const tc = (name: string, args: object) => ({ name, arguments: JSON.stringify(args) });
const sys = (body: any) => String(body.messages?.[0]?.content || "");
const isRole = (body: any, opening: string) => sys(body).startsWith(opening);
const PLANNER = "You are a software architect";
const WORKER = "You are a software engineering worker";
const REVIEWER = "You are a rigorous code reviewer";

beforeEach(() => {
  mock.reset();
  resetPipeline();
});

test("F-CTX-1: a result that quotes a marker is stripped, and fit() never commits a partial cut", () => {
  const quoting = `const STRIPPED = "[output stripped:"; const DROPPED = "[output dropped:";\n${"x".repeat(9_000)}`;
  const call = (id: string) => ({ role: "assistant", content: "", toolCalls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] }) as any;
  const tool = (id: string, content: string) => ({ role: "tool", toolCallId: id, content }) as any;
  const turn: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }, call("a"), tool("a", quoting), { role: "assistant", content: "ok" }];
  assert.equal(history.strip(turn), 1, "a file that merely contains the marker strings is still stripped");

  const messages: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }, call("a"), tool("a", quoting), call("b"), tool("b", "y".repeat(900))];
  const before = JSON.stringify(messages);
  const tooSmall = history.fit(messages, 200);
  assert.ok(!tooSmall.fits);
  assert.equal(JSON.stringify(messages), before, "an unreachable budget leaves the transcript exactly as it was");
  assert.ok(history.fit(messages, 1_500).fits, "and a reachable one is reached by stubbing the quoting result");
});

test("F-CMP-1: compaction never summarises results the model has not read", async () => {
  mock.setScript(() => ({ content: "## Goal\nread ten files" }));
  const calls = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }));
  const messages: any[] = [
    { role: "system", content: "s" },
    { role: "user", content: "Read the ten modules." },
    { role: "assistant", content: "", toolCalls: calls },
    ...calls.map((c) => ({ role: "tool", toolCallId: c.id, content: history.cap("export const x = 1;\n".repeat(700)) }))
  ];
  const done = await compact(messages);
  assert.equal(messages.filter((m) => m.role === "tool").length, 10, "all ten unread results are still there");
  assert.equal(done.changed, true, "the request before them was compacted, though the count did not drop");
  history.sweep();
});

test("F-SEC-1: confirmed permission bypasses now ask", () => {
  for (const cmd of [
    "rg --pre=rm -e x .",
    "uniq notes.txt package.json",
    "sort -opackage.json /dev/null",
    "sort --out=package.json /dev/null",
    "find . -fprint0 package.json",
    "cat <.env",
    "cat .en?",
    "head -c 400 .e''nv",
    "git diff --no-index /dev/null ~/.npmrc",
    "cat ~/.config/gh/hosts.yml",
    "git branch -u origin/main"
  ]) {
    assert.equal(decide(cmd, true), "ask", cmd);
  }
  for (const cmd of ["Get-Content (Remove-Item -Recurse -Force src)", "echo @(Remove-Item -Recurse src)"]) {
    assert.equal(decide(cmd, false), "ask", `PowerShell: ${cmd}`);
  }
  assert.equal(decide("pytest -q", true, true), "ask", "a role that cannot ask may not run project code");
  assert.equal(decide("pytest -q", true, false), "allow", "with a human in the loop it still flows");
  assert.equal(check("grep", { pattern: "KEY", path: ".env" }).action, "ask");
  for (const cmd of ["cat .e*", "cat *rsa", "cat .[e]nv"]) {
    assert.equal(decide(cmd, true), "ask", `a glob aimed at a credentials file: ${cmd}`);
  }
  for (const benign of ["sort -n data.txt", "uniq -c counts.txt", "find . -name '*.ts' -print", "cat package.json", "ls *", "cat src/*", "wc -l *.ts", "grep -n TODO src/*"]) {
    assert.equal(decide(benign, true), "allow", benign);
  }
});

test("F-TOOL-1: spill files can be paged without approval; long files come back paged", async () => {
  const capped = history.cap("z".repeat(20_000));
  const spill = capped.match(/The whole output is at (.+?) - page/)![1];
  assert.equal(check("read_file", { path: spill }).action, "allow", "the harness's own temp file");
  assert.equal(check("read_file", { path: path.join(os.tmpdir(), "someone-else.txt") }).action, "ask", "any other temp file still asks");
  history.sweep();
  assert.equal(check("read_file", { path: spill }).action, "ask", "once swept it is just a path outside the project");

  fs.writeFileSync(path.join(WORK, "long.txt"), Array.from({ length: 2_000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const page = await readFileTool.execute({ path: "long.txt" });
  assert.match(page, /^\[Lines 1 to \d+ of 2000 - too long to show at once\. Continue with offset=\d+/);
  assert.ok(page.length <= history.CAP, "small enough that cap() never spills it, so paging cannot number lines twice");
});

test("F-SES-1: --resume skips logs that hold only a system prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sessions-"));
  const real = Session.create(dir);
  real.sync([{ role: "system", content: "s" }, { role: "user", content: "real work" }] as any);
  await new Promise((r) => setTimeout(r, 20));
  Session.create(dir).sync([{ role: "system", content: "s" }] as any);
  assert.equal(resumable(dir)?.file, real.file);
});

test("F-SUB-1: a planner that runs out of turns does not become a plan", async () => {
  mock.setScript((body) => {
    if (isRole(body, PLANNER)) {
      const forced = String(body.messages.at(-1)?.content).startsWith("You are out of turns");
      return forced ? { content: "I was still looking at README.md." } : { content: "", toolCalls: [tc("glob", { pattern: "*.md" })] };
    }
    return body.messages.at(-2)?.role === "tool" ? { content: "stopping" } : { content: "", toolCalls: [tc("plan_task", { goal: "Add a CHANGELOG" })] };
  });
  const result = await runAgent("plan it", { onApprove: async () => true });
  const report = String(result.messages.find((m: any) => m.role === "tool")?.content);
  assert.match(report, /^The planner did not finish \(out of turns\), so nothing was saved as a plan/);
  assert.equal(getPlan(), null);
});

test("F-SUB-2: a reviewer out of turns can still submit its verdict", async () => {
  let k = 0;
  mock.setScript((body) => {
    if (isRole(body, PLANNER)) return { content: "## Steps\n1. Add CHANGELOG.md" };
    if (isRole(body, WORKER)) return { content: "Added it" };
    if (isRole(body, REVIEWER)) {
      return body.tool_choice === "required"
        ? { content: "", toolCalls: [tc("submit_review", { verdict: "approved", summary: "Fine." })] }
        : { content: "", toolCalls: [tc("glob", { pattern: "*.md" })] };
    }
    k++;
    return k === 1 ? { content: "", toolCalls: [tc("plan_task", { goal: "CHANGELOG" })] }
      : k === 2 ? { content: "", toolCalls: [tc("work_task", {})] }
        : k === 3 ? { content: "", toolCalls: [tc("review_task", {})] }
          : { content: "done" };
  });
  const result = await runAgent("pipeline", { onApprove: async () => true });
  const review = result.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content))[2];
  assert.match(review, /^VERDICT: APPROVED/);
  assert.equal(getPlan()?.reworks, 0, "no rework cycle spent on a missing verdict");
});

test("F-SUB-3: once the turn is cancelled, a subagent runs none of its remaining calls", async () => {
  const controller = new AbortController();
  let k = 0;
  mock.setScript((body) => {
    if (isRole(body, PLANNER)) return { content: "Plan: write after.txt" };
    if (isRole(body, WORKER)) {
      setTimeout(() => controller.abort(new CancelledError()), 500);
      return { content: "", toolCalls: [tc("bash", { command: 'node -e "setTimeout(()=>{},3000)"' }), tc("write_file", { path: "after.txt", content: "x" })] };
    }
    k++;
    return k === 1 ? { content: "", toolCalls: [tc("plan_task", { goal: "x" })] } : { content: "", toolCalls: [tc("work_task", {})] };
  });
  const result = await runAgent("go", { onApprove: async () => true, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.ok(!fs.existsSync(path.join(WORK, "after.txt")), "the write queued behind the cancelled command never ran");
});

test("F-LLM-1: a call cut off by the output limit is reported as such and never run", async () => {
  let k = 0;
  mock.setScript(() => {
    k++;
    return k === 1
      ? { content: "", toolCalls: [{ name: "write_file", arguments: '{"path":"big.ts","content":"export const t = [1, 2,' }], finishReason: "length" }
      : { content: "I will write it in parts." };
  });
  const result = await runAgent("write the table", { onApprove: async () => true });
  const told = String(result.messages.find((m: any) => m.role === "tool")?.content);
  assert.match(told, /hit the output-token limit/);
  assert.match(told, /in parts/);
  assert.ok(!fs.existsSync(path.join(WORK, "big.ts")));
});

test("F-RUN-1: a timed-out command takes its child processes with it", async () => {
  const pidFile = path.join(WORK, "child.pid").replace(/\\/g, "/");
  await assert.rejects(
    run(`node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 20000)" ; true`, 1_500)
  );
  await new Promise((r) => setTimeout(r, 500));
  const pid = Number(fs.readFileSync(pidFile, "utf-8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) process.kill(pid);
  assert.equal(alive, false, "the grandchild was killed with the shell");
});
