// [L-2] A reviewer that runs out of turns. The mock behaves like a provider
// that honours tool_choice="required": asked that way, it submits a verdict.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { at, offline } from "./_root.mts";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "review-probe-"));
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "README.md"), "# demo\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);
offline();
process.env.SESSION_DIR = path.join(os.tmpdir(), `${path.basename(WORK)}-sessions`);
const mock = await import(at("tests/helpers/mock.ts"));
mock.install();
const { runAgent } = await import(at("src/agent.ts"));
const { getPlan } = await import(at("src/pipeline.ts"));
const say = console.log.bind(console);
console.log = () => {};
const opening = (b: any) => String(b.messages?.[0]?.content || "");
const tc = (name: string, args: object) => ({ name, arguments: JSON.stringify(args) });
let k = 0;
mock.setScript((b: any) => {
  if (opening(b).startsWith("You are a software architect")) return { content: "## Steps\n1. Add CHANGELOG.md" };
  if (opening(b).startsWith("You are a software engineering worker")) return { content: "Added CHANGELOG.md" };
  if (opening(b).startsWith("You are a rigorous code reviewer")) {
    if (b.tool_choice === "required") return { content: "", toolCalls: [tc("submit_review", { verdict: "approved", summary: "Checked; fine." })] };
    if (String(b.messages.at(-1)?.content).startsWith("You are out of turns")) return { content: "Everything I saw looks fine." };
    return { content: "", toolCalls: [tc("glob", { pattern: "*.md" })] };
  }
  k++;
  return [
    { content: "", toolCalls: [tc("plan_task", { goal: "Add a CHANGELOG" })] },
    { content: "", toolCalls: [tc("work_task", {})] },
    { content: "", toolCalls: [tc("review_task", {})] }
  ][k - 1] ?? { content: "done" };
});
const res = await runAgent("pipeline please", { onApprove: async () => true });
const review = res.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content))[2];
const calls = mock.requests.filter((b: any) => opening(b).startsWith("You are a rigorous code reviewer"));
const last = calls.at(-1);
say(`[L-2] reviewer: ${calls.length} calls; the last offered [${(last.tools || []).map((t: any) => t.function.name).join(", ")}], tool_choice=${last.tool_choice ?? "(none)"}`);
say(`      review_task -> ${JSON.stringify(review.split("\n").filter(Boolean).slice(0, 2).join(" / "))}`);
say(`      rework cycles spent: ${getPlan()?.reworks} (the next work_task would ${review.startsWith("VERDICT: APPROVED") ? "not be needed" : "count as rework 1 of 2"})`);
process.chdir(os.tmpdir());
