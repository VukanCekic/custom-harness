// [L-6] finish_reason=length: the reply hit the output limit mid tool call.
// What is the model told, and what does the loop cost? Own SSE mock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { at, offline } from "./_root.mts";
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "length-probe-"));
execSync("git init -q", { cwd: WORK });
process.chdir(WORK);
offline();
process.env.SESSION_DIR = path.join(os.tmpdir(), `${path.basename(WORK)}-sessions`);
process.env.MAX_STEPS = "6";
const bodies: any[] = [];
(globalThis as any).fetch = async (input: any, init?: any) => {
  const req: Request = input instanceof Request ? input : new Request(input, init);
  const body = JSON.parse(await req.text());
  bodies.push(body);
  const base = { id: "m", created: 1, model: String(body.model), object: "chat.completion.chunk" };
  const args = '{"path":"big.ts","content":"export const table = [1, 2, 3, 4, 5, 6, 7, 8, 9,';
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${bodies.length}`, type: "function", function: { name: "write_file", arguments: args } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292, cost: 0.002 } }
  ];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
};
const say = console.log.bind(console);
console.log = () => {};
const { runAgent } = await import(at("src/agent.ts"));
const res = await runAgent("generate the lookup table file", { onApprove: async () => true });
const told = res.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
const completion = res.stepUsage.reduce((s: number, u: any) => s + (u.completion_tokens || 0), 0);
say(`[L-6] ${res.steps} steps, max_tokens sent: ${bodies[0].max_tokens ?? "(none)"}; the model was told, every time:\n      ${JSON.stringify(told[0])}`);
say(`      ${completion.toLocaleString()} billed output tokens thrown away (at the default MAX_STEPS=60: ${(completion * 10).toLocaleString()})`);
process.chdir(os.tmpdir());
