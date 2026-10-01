/**
 * End-to-end verification of the REAL agent loop / subagent runner against a
 * scripted mock LLM (fetch is stubbed - nothing leaves the machine).
 *
 *   tsx verify_loop.ts <scenario>
 *
 * Each scenario runs in its own process because config is read at import time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2] || "A";
const REPO = process.env.HARNESS_ROOT || "D:/code/coding-harness";
const mod = (p: string) => import(pathToFileURL(path.join(REPO, p)).href);

const WINDOWS: Record<string, string> = { A: "3500", A2: "6000", H: "3500", G: "16000" };
process.env.CONTEXT_WINDOW = WINDOWS[scenario] || "64000";
if (scenario === "E") process.env.MAX_STEPS = "25";
process.env.OPENROUTER_API_KEY = "sk-or-mock-never-sent";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), `harness-loop-${scenario}-`));
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "README.md"), "# demo\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);

const mock = await import("./mock.ts");
mock.install();
const { runAgent } = await mod("src/agent.ts");
const history = await mod("src/history.ts");

function roleOf(body: any): string {
  // classify by the opening sentence: the main prompt mentions every role by name
  const sys = String(body.messages?.[0]?.content || "").trimStart();
  if (sys.startsWith("You are a coding agent")) return "main";
  if (sys.startsWith("You are compacting the transcript")) return "summarizer";
  if (sys.startsWith("You are a research subagent")) return "researcher";
  if (sys.startsWith("You are a software architect and planning subagent")) return "planner";
  if (sys.startsWith("You are a software engineering worker subagent")) return "worker";
  if (sys.startsWith("You are a rigorous code reviewer subagent")) return "reviewer";
  return "unknown";
}
const counters: Record<string, number> = {};
const nth = (role: string) => (counters[role] = (counters[role] || 0) + 1);
const call = (name: string, args: any) => ({ name, arguments: JSON.stringify(args) });
const say = (s: string) => console.log(s);

// ============================================================================
if (scenario === "A" || scenario === "A2") {
  say(`${scenario}: incident reproduction - CONTEXT_WINDOW=${process.env.CONTEXT_WINDOW}, one user turn: 3 orchestration calls, then 4x echo ok`);
  const userPrompt =
    "In a separate folder 'playground/calculator-app', build a standalone TypeScript calculator library with operations " +
    "(add, subtract, multiply, divide, power, factorial) and a test script. Do not touch or modify anything in src/. Follow the full multi-agent pipeline.";
  const seen: string[] = [];
  const summarizerInputs: string[] = [];
  mock.setScript((body) => {
    const role = roleOf(body);
    const k = nth(role);
    if (role === "summarizer") {
      summarizerInputs.push(String(body.messages[1].content));
      // same size as the real handoff note in the incident run (~4.3k chars)
      return { content: "## Goal\n" + "Build a calculator app (reconstructed). ".repeat(20) + "\n## What happened\n" + "probe output lost. ".repeat(180) };
    }
    if (role !== "main") return { content: `${role} report: scaffolded the calculator` };
    if (k > 1) seen.push(mock.lastToolResults(body).join(" | "));
    // like the incident: orchestration calls carry ~2.4k chars of arguments each
    if (k <= 3) return { content: "Delegating.", toolCalls: [call(k === 3 ? "review_task" : "work_task", { plan: "Scaffold the calculator. ".repeat(96), goal: "calculator" })] };
    if (k <= 7) return { content: "", toolCalls: [call("bash", { command: "echo ok" })] };
    return { content: "I cannot see any tool output." };
  });
  let result: any = { messages: [], totalCost: 0 };
  try {
    result = await runAgent(userPrompt, { onApprove: async () => true });
  } catch (e: any) {
    say(`  runAgent stopped with ${e.name}: ${String(e.message).slice(0, 220)}`);
  }
  say(`  main-agent requests: ${counters.main}, worker requests: ${counters.worker || 0}, summarizer (compaction) calls: ${counters.summarizer || 0}`);
  say(`  what the model saw for each of its tool calls:`);
  seen.forEach((s, i) => say(`    step ${i + 2}: ${s.slice(0, 90)}`));
  const blind = seen.filter((s) => s.includes("[output dropped")).length;
  say(`  => ${blind}/${seen.length} tool results reached the model as "[output dropped]"`);
  summarizerInputs.forEach((inp, i) => {
    const hasPrompt = inp.includes("Do not touch or modify anything in src/");
    const hasPrevSummary = inp.includes("USER: <summary>");
    say(`  compaction #${i + 1}: summariser input contains the user's verbatim constraint: ${hasPrompt}; contains a previous summary rendered as USER: ${hasPrevSummary}`);
  });
  const finalHasConstraint = (result.messages || []).some((m: any) => String(m.content).includes("Do not touch or modify anything in src/"));
  say(`  after the turn, the user's verbatim constraint survives anywhere in the transcript: ${finalHasConstraint}`);
  const totalMockCost = mock.requests.length * 0.0001;
  say(`  cost reported by runAgent: $${result.totalCost.toFixed(4)}  vs  actually billed (all ${mock.requests.length} calls): $${totalMockCost.toFixed(4)}`);
}

// ============================================================================
if (scenario === "B") {
  say("B: a subagent's sweep() deletes the PARENT's spill file mid-turn");
  fs.writeFileSync(path.join(WORK, "big.log"), Array.from({ length: 800 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"));
  let spillPath = "";
  let afterSubagent = "";
  mock.setScript((body) => {
    const role = roleOf(body);
    const k = nth(role);
    if (role === "researcher") return { content: "MAX_TURNS is defined in src/tools/task.ts:10." };
    if (role !== "main") return { content: "?" };
    if (k === 1) return { toolCalls: [call("read_file", { path: "big.log" })] };
    if (k === 2) {
      const r = mock.lastToolResults(body)[0];
      spillPath = (r.match(/whole output is at (.+?) - page/) || [])[1] || "";
      say(`  step 1 result was capped; parent was told the full text is at ${spillPath} (exists now: ${fs.existsSync(spillPath)})`);
      return { toolCalls: [call("task", { description: "Where is MAX_TURNS defined?" })] };
    }
    if (k === 3) return { toolCalls: [call("read_file", { path: spillPath, offset: 400, limit: 5 })] };
    afterSubagent = mock.lastToolResults(body)[0];
    return { content: "done" };
  });
  await runAgent("Summarise big.log, and find MAX_TURNS.", { onApprove: async () => true });
  say(`  after the task subagent returned, the parent paged its own spill file and got: ${JSON.stringify(afterSubagent.slice(0, 160))}`);
  say(`  => ${afterSubagent.includes("ENOENT") ? "BUG REPRODUCED: parent's spill deleted by subagent sweep()" : "not reproduced"}`);
}

// ============================================================================
if (scenario === "C") {
  say("C: subagents bypass the permission engine (confused deputy)");
  const approvals: string[] = [];
  const writeCmd = (f: string) => `node -e "require('fs').writeFileSync('${f}','x')"`;
  const outside = path.join(path.dirname(WORK), `outside-written-by-worker-${Date.now()}.txt`);
  mock.setScript((body) => {
    const role = roleOf(body);
    const k = nth(role);
    if (role === "main") {
      if (k === 1) return { toolCalls: [call("bash", { command: writeCmd("by-main.txt") })] };
      if (k === 2) return { toolCalls: [call("work_task", { plan: "write the files" })] };
      if (k === 3) return { toolCalls: [call("task", { description: "look around" })] };
      return { content: "done" };
    }
    if (role === "worker") {
      if (k === 1) return { toolCalls: [call("bash", { command: writeCmd("by-worker.txt") }), call("write_file", { path: outside, content: "outside the project" })] };
      return { content: "worker done" };
    }
    if (role === "researcher") {
      if (k === 1) return { toolCalls: [call("bash", { command: writeCmd("by-readonly-researcher.txt") })] };
      return { content: "found nothing" };
    }
    return { content: "?" };
  });
  await runAgent("try to write files", { onApprove: async (reason: string) => { approvals.push(reason); return false; } });
  say(`  approval prompts shown to the user: ${approvals.length} -> ${JSON.stringify(approvals)}`);
  for (const f of ["by-main.txt", "by-worker.txt", "by-readonly-researcher.txt"]) say(`  ${f.padEnd(28)} exists: ${fs.existsSync(path.join(WORK, f))}`);
  say(`  worker wrote OUTSIDE the project root without asking: ${fs.existsSync(outside)} (${outside})`);
  if (fs.existsSync(outside)) fs.unlinkSync(outside);
}

// ============================================================================
if (scenario === "D") {
  say("D: malformed / truncated tool-call JSON is executed with {} instead of being reported");
  let seenWrite = "", seenBash = "";
  mock.setScript((body) => {
    const k = nth(roleOf(body));
    if (k === 1) return { toolCalls: [{ name: "write_file", arguments: '{"path": "notes.md", "content": "line1\\nline2' }] };
    if (k === 2) { seenWrite = mock.lastToolResults(body)[0]; return { toolCalls: [{ name: "bash", arguments: '{"command": "npm test' }] }; }
    seenBash = mock.lastToolResults(body)[0];
    return { content: "done" };
  });
  await runAgent("write notes", { onApprove: async () => true });
  say(`  truncated write_file args -> model saw: ${JSON.stringify(seenWrite)}`);
  say(`  truncated bash args       -> model saw: ${JSON.stringify(seenBash.slice(0, 160))}`);
}

// ============================================================================
if (scenario === "E") {
  say("E: no step limit - a model that never stops calling tools");
  mock.setScript((body) => (nth(roleOf(body)) < 80 ? { toolCalls: [call("bash", { command: "echo again" })] } : { content: "fine, stopping" }));
  const t0 = performance.now();
  const r = await runAgent("loop", { onApprove: async () => true });
  say(`  runAgent ran ${r.steps} steps in ${Math.round(performance.now() - t0)}ms; the mock wanted 80, MAX_STEPS=25 is set. final=${JSON.stringify(r.finalResponse).slice(0, 90)}`);
}

// ============================================================================
if (scenario === "F") {
  say("F: prefix-cache stability - byte-level common prefix between consecutive main-agent requests");
  const fileBody = "y".repeat(2500);
  fs.writeFileSync(path.join(WORK, "f.txt"), fileBody);
  mock.setScript((body) => {
    const k = nth(roleOf(body));
    if (k === 1 || k === 2 || k === 4) return { toolCalls: [call("read_file", { path: "f.txt" })] };
    return { content: `answer ${k}` };
  });
  let messages: any = undefined;
  const r1 = await runAgent("turn one", { onApprove: async () => true });
  messages = r1.messages;
  await runAgent("turn two", { messages, onApprove: async () => true });
  const sers = mock.rawBodies.map((b) => {
    const j = JSON.parse(b);
    return { msgs: JSON.stringify(j.messages.slice(0, -1)), tools: JSON.stringify(j.tools), n: j.messages.length };
  });
  for (let i = 1; i < sers.length; i++) {
    const a = sers[i - 1].msgs, b = sers[i].msgs;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const pct = ((100 * p) / a.length).toFixed(1);
    say(`  req ${i}->${i + 1}: tools identical=${sers[i - 1].tools === sers[i].tools}; ${pct}% of previous request (minus reminder) is a byte-identical prefix of the next; ${b.length - p} chars must be re-prefilled`);
  }
}

// ============================================================================
if (scenario === "G") {
  say("G: subagent transcript grows without fit()/compaction (CONTEXT_WINDOW=16000, budget 13600)");
  fs.writeFileSync(path.join(WORK, "mod.ts"), "z".repeat(9000));
  const sizes: number[] = [];
  mock.setScript((body) => {
    const role = roleOf(body);
    const k = nth(role);
    if (role === "main") return k === 1 ? { toolCalls: [call("task", { description: "read every module" })] } : { content: "done" };
    sizes.push(Math.ceil(JSON.stringify(body.messages).length / 4));
    return k < 15 ? { toolCalls: [call("read_file", { path: "mod.ts" })] } : { content: "report" };
  });
  await runAgent("explore", { onApprove: async () => true });
  say(`  researcher request sizes (est. tokens): ${sizes.join(", ")}`);
  say(`  => last subagent request ${sizes[sizes.length - 1]} est. tokens vs main-loop budget ${16000 * 0.85}: ${sizes[sizes.length - 1] > 13600 ? "OVERFLOWS (a real provider would 400 here)" : "ok"}`);
}

// ============================================================================
if (scenario === "H") {
  say("H: the compaction call fails (HTTP 400, e.g. summariser input too long) - does the turn survive? (CONTEXT_WINDOW=3500)");
  let mainCalls = 0;
  mock.setScript((body) => {
    if (roleOf(body) === "summarizer") return { status: 400 };
    mainCalls++;
    return mainCalls === 1
      ? { content: "I will now run the tests.", toolCalls: [call("bash", { command: "echo tests" })], promptTokens: 5000 }
      : { content: "Tests ran.", promptTokens: 5000 };
  });
  const msgs: any[] = [{ role: "system", content: "sys" }, { role: "user", content: "old task" }];
  for (let i = 0; i < 3; i++) {
    msgs.push(
      { role: "assistant", content: "", toolCalls: [{ id: `o${i}`, type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }] },
      { role: "tool", toolCallId: `o${i}`, content: "old output ".repeat(300) }
    );
  }
  msgs.push({ role: "assistant", content: "done with the old task" });
  const before = msgs.length;
  try {
    const r = await runAgent("continue", { messages: msgs, onApprove: async () => true, onNote: (t: string) => say(`  note: ${t}`) } as any);
    say(`  runAgent RESOLVED: final=${JSON.stringify(r.finalResponse)} after ${r.steps} steps; the tool call ran: ${msgs.some((m: any) => m.role === "tool" && String(m.content).includes("tests"))}`);
  } catch (e: any) {
    say(`  runAgent REJECTED: ${e.name}: ${String(e.message).slice(0, 100)}`);
    say(`  the paid-for assistant response was pushed to history: ${msgs.length > before + 1} (messages ${before} -> ${msgs.length}); its tool call never ran`);
  }
}

// ============================================================================
if (scenario === "I") {
  say("I: provider error handling");
  const { callLLM } = await mod("src/llm.ts");
  // a transient rate limit: 429 once, then OK
  mock.reset();
  mock.setScript((_b, i) => (i < 1 ? { status: 429 } : { content: "after the rate limit" }));
  try {
    const ok = await callLLM([{ role: "user", content: "hi" }], null);
    say(`  429,200: RETRIED - ${mock.requests.length} attempts, content=${JSON.stringify(ok.message.content)}`);
  } catch (e: any) {
    say(`  429,200: thrown after ${mock.requests.length} attempt(s) - a single transient rate limit kills the turn (${e.name})`);
  }
  // 503 x2 then OK -> retried by SDK default (5XX only)
  mock.reset();
  mock.setScript((_b, i) => (i < 2 ? { status: 503 } : { content: "recovered" }));
  const t0 = performance.now();
  const r = await callLLM([{ role: "user", content: "hi" }], null);
  say(`  503,503,200: ${mock.requests.length} attempts, ${Math.round(performance.now() - t0)}ms, content=${JSON.stringify(r.message.content)} (SDK default: backoff on 5XX for up to maxElapsedTime=3,600,000ms, request timeout -1)`);
  // mid-stream error chunk -> silently treated as a complete answer
  mock.reset();
  mock.setScript(() => ({ content: "Here is the first half of the answ", errorChunkAfterContent: true }));
  try {
    const m = await callLLM([{ role: "user", content: "hi" }], null);
    say(`  mid-stream error chunk: callLLM resolved normally with content=${JSON.stringify(m.message.content)} - error and finish_reason=error ignored`);
  } catch (e: any) {
    say(`  mid-stream error chunk: SURFACED as an error - ${String(e.message).slice(0, 90)}`);
  }
  // provider re-sends function.name in every delta
  mock.reset();
  mock.setScript(() => ({ toolCalls: [call("bash", { command: "ls" })], repeatNameInEveryChunk: true }));
  const d = await callLLM([{ role: "user", content: "hi" }], null);
  say(`  name repeated per delta: assembled tool name=${JSON.stringify(d.message.toolCalls?.[0]?.function?.name)}`);
}

// ============================================================================
if (scenario === "J") {
  say("J: compaction integrity across three successive compactions (CONTEXT_WINDOW=64000)");
  const { compact, render } = await mod("src/compact.ts");
  const constraint = "Build it in playground/calculator-app. Do not touch or modify anything in src/.";
  const tricky = "Stopped the server with `kill $$`; quoted with `echo $'a\\tb'`; regex used `$&`.";
  const inputs: string[] = [];
  mock.setScript((body) => {
    inputs.push(String(body.messages[1].content));
    return { content: `## Goal\nCalculator (generation ${inputs.length}).\n## What happened\n${tricky}` };
  });
  const messages: any[] = [{ role: "system", content: "sys" }, { role: "user", content: constraint }];
  const grow = (n: number) => {
    for (let i = 0; i < n; i++) {
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: `g${messages.length}`, type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] });
      messages.push({ role: "tool", toolCallId: `g${messages.length - 1}`, content: "x".repeat(9_000) });
      messages.push({ role: "assistant", content: "next" }, { role: "user", content: "keep going" });
    }
  };
  let costs = 0;
  for (let gen = 1; gen <= 3; gen++) {
    grow(14);
    const out = await compact(messages);
    costs += Array.isArray(out) ? 0 : out.cost;
  }
  const handoff = String(messages[1].content);
  say(`  summary text survives substitution verbatim: ${handoff.includes(tricky)}`);
  say(`  user's original constraint present verbatim after 3 compactions: ${handoff.includes(constraint)}`);
  say(`  3rd summariser input labels the earlier note as: ${JSON.stringify(inputs[2]?.slice(0, 22))}`);
  say(`  compaction cost reported to the caller: ${costs > 0 ? `$${costs.toFixed(4)}` : "not reported"}`);
  say(`  summariser calls: ${inputs.length}`);
}

console.log(`  (workdir ${WORK})`);
