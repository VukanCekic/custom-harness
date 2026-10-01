// [L-1] planner out of turns, [L-3] cancel vs a subagent's queued calls,
// [L-4] pipeline mode and the prompt cache, [L-5] a same-length compaction,
// [L-7] which session --resume picks, [L-8] read-only roles paging a spill.
// The real loop against the project's scripted mock LLM; throwaway git repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { at, offline } from "./_root.mts";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "loop-probe-"));
execSync("git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "README.md"), "# demo\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);
offline();
process.env.SESSION_DIR = path.join(os.tmpdir(), `${path.basename(WORK)}-sessions`);
process.env.STRIP_AFTER = "0.99";
delete process.env.MODEL;
delete process.env.PROVIDER_ONLY;

const mock = await import(at("tests/helpers/mock.ts"));
mock.install();
const { runAgent } = await import(at("src/agent.ts"));
const { compact } = await import(at("src/compact.ts"));
const { resetPipeline, getPlan } = await import(at("src/pipeline.ts"));
const { CancelledError } = await import(at("src/scope.ts"));
const session = await import(at("src/session.ts"));
const { getSystemPrompt } = await import(at("src/config.ts"));
const { execute } = await import(at("src/execute.ts"));
const { readFileTool } = await import(at("src/tools/readFile.ts"));
const history = await import(at("src/history.ts"));

const say = console.log.bind(console);
console.log = () => {}; // the harness's own panels
const opening = (b: any) => String(b.messages?.[0]?.content || "");
const role = (b: any) =>
  opening(b).startsWith("You are a coding agent") ? "main"
    : opening(b).startsWith("You are a software architect") ? "planner"
      : opening(b).startsWith("You are a software engineering worker") ? "worker"
        : opening(b).startsWith("You are compacting") ? "summarizer" : "other";
const tc = (name: string, args: object) => ({ name, arguments: JSON.stringify(args) });
const lastUser = (b: any) => String(b.messages.at(-1)?.content || "");

{ // L-1
  mock.reset(); resetPipeline(); let k = 0;
  mock.setScript((b: any) => {
    if (role(b) === "planner") {
      return lastUser(b).startsWith("You are out of turns") ? { content: "I was still looking at README.md." } : { content: "", toolCalls: [tc("glob", { pattern: "*.md" })] };
    }
    k++;
    return k === 1 ? { content: "", toolCalls: [tc("plan_task", { goal: "Add a CHANGELOG" })] } : { content: "done" };
  });
  const res = await runAgent("plan it", { onApprove: async () => true });
  const result = String(res.messages.find((m: any) => m.role === "tool")?.content);
  say(`[L-1] plan_task result: ${JSON.stringify(result.slice(0, 110))}...`);
  say(`      stored plan: ${JSON.stringify(getPlan()?.text ?? null)}`);
}

{ // L-3
  mock.reset(); resetPipeline();
  const controller = new AbortController(); let k = 0; let w = 0;
  mock.setScript((b: any) => {
    if (role(b) === "planner") return { content: "Plan: write after-cancel.txt" };
    if (role(b) === "worker") {
      w++;
      if (w === 1) {
        setTimeout(() => controller.abort(new CancelledError()), 700);
        return { content: "", toolCalls: [tc("bash", { command: 'node -e "setTimeout(()=>{},4000)"' }), tc("write_file", { path: "after-cancel.txt", content: "x" })] };
      }
      return { content: "never asked" };
    }
    k++;
    return k === 1 ? { content: "", toolCalls: [tc("plan_task", { goal: "x" })] } : { content: "", toolCalls: [tc("work_task", {})] };
  });
  const res = await runAgent("go", { onApprove: async () => true, signal: controller.signal });
  say(`[L-3] Ctrl+C at 700 ms, during the worker's first command: cancelled=${res.cancelled}; ` +
    `the write queued behind it ${fs.existsSync(path.join(WORK, "after-cancel.txt")) ? "RAN anyway" : "did not run"}`);
}

{ // L-4
  mock.reset(); resetPipeline(); let k = 0;
  const messages: any[] = [{ role: "system", content: getSystemPrompt("default") }];
  mock.setScript((b: any) => {
    if (role(b) === "planner") return { content: "Plan." };
    k++;
    return [
      { content: "", toolCalls: [tc("bash", { command: "git status --short" })] },
      { content: "", toolCalls: [tc("plan_task", { goal: "y" })] },
      { content: "planned" },
      { content: "", toolCalls: [tc("bash", { command: "git log --oneline -1" })] }
    ][k - 1] ?? { content: "ok" };
  });
  const fmt = (r: any) => JSON.stringify(r.cacheBreaks.map((c: any) => ({ step: c.step, reused: +c.reused.toFixed(2), reason: c.reason })));
  const t1 = await runAgent("first", { messages, onApprove: async () => true });
  const t2 = await runAgent("second", { messages, onApprove: async () => true });
  say(`[L-4] cache breaks - pipeline turn: ${fmt(t1)}; next plain turn: ${fmt(t2)}`);
}

{ // L-5
  mock.reset(); let summarized = 0;
  mock.setScript((b: any) => { if (role(b) === "summarizer") summarized++; return { content: "## Goal\nsummary" }; });
  const m: any[] = [{ role: "system", content: "s" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi there" }];
  const done = await compact(m, true);
  const noticed = done.changed ?? m.length < 3; // index.ts used the length before the patch
  say(`[L-5] /compact on 3 messages: summariser paid ${summarized}x, handoff written=${String(m[1].content).startsWith("<summary>")}, ` +
    `3 -> ${m.length} messages, /compact ${noticed ? "logs it" : 'prints "Nothing to compact yet." and does not log it'}`);
}

{ // L-7
  const real = session.Session.create();
  real.sync([{ role: "system", content: "s" }, { role: "user", content: "real work" }, { role: "assistant", content: "done" }]);
  await new Promise((r) => setTimeout(r, 30));
  const empty = session.Session.create();
  empty.sync([{ role: "system", content: "s" }]); // a launch that was quit at once
  const pick = session.resumable ? session.resumable() : session.listSessions().find((s: any) => s.messages > 0);
  say(`[L-7] --resume picks: ${pick?.file === empty.file ? "the EMPTY session (system prompt only)" : "the session with real work"}`);
}

{ // L-8
  const capped = history.cap("z".repeat(20_000));
  const spill = capped.match(/The whole output is at (.+?) - page/)![1];
  const r = await execute({ id: "c", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: spill, offset: 1, limit: 1 }) } }, { tools: { read_file: readFileTool } });
  say(`[L-8] read-only role pages its own spill file -> ${r.result.slice(0, 95).replace(/\n/g, " | ")}`);
  history.sweep();
}
process.chdir(os.tmpdir());
