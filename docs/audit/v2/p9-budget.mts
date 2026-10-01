// [B-1] Fixed overhead per request and the smallest usable CONTEXT_WINDOW.
// [B-2] estimate() and per-token prices, calibrated against what the provider
// actually billed in this project's recorded runs (~/.agents/sessions/...).
import fs from "node:fs";
import path from "node:path";
import { at, offline, ROOT } from "./_root.mts";
offline();
const { overhead } = await import(at("src/agent.ts"));
const { toolsFor } = await import(at("src/tools/index.ts"));
const { estimate } = await import(at("src/history.ts"));
const { getSystemPrompt } = await import(at("src/config.ts"));
const { sessionDir } = await import(at("src/session.ts"));

for (const mode of ["default", "pipeline"] as const) {
  const t = toolsFor(mode);
  const sys = estimate([{ role: "system", content: getSystemPrompt(mode) } as any]);
  const fixed = overhead(t.schemas) + sys;
  const first = fixed + estimate([{ role: "user", content: "fix the failing test in src/foo.ts" } as any]);
  console.log(`[B-1] ${mode.padEnd(8)} ${t.schemas.length} tools ~${Math.ceil(JSON.stringify(t.schemas).length / 4)} tokens + system prompt ~${sys} + 300 reserve = ~${fixed} per request; ` +
    `step 1 refused below CONTEXT_WINDOW=${Math.ceil(first / 0.85)}, start-up warning below ~${Math.ceil((fixed * 2) / 0.85)}`);
}

const runs = path.join(sessionDir(ROOT), "runs");
if (!fs.existsSync(runs)) {
  console.log(`[B-2] no recorded runs in ${runs}`);
} else {
  const schema = Math.ceil(JSON.stringify(toolsFor("default").schemas).length / 4);
  const reminder = { role: "user", content: "<env>\ntime: 2026-10-01 20:08\ngit branch: main\n</env>" };
  const est: Array<[number, number]> = [];
  const bill: number[][] = [];
  for (const f of fs.readdirSync(runs)) {
    const run = JSON.parse(fs.readFileSync(path.join(runs, f), "utf-8"));
    const msgs: any[] = run.transcript;
    const starts = msgs.map((m, i) => (m.role === "assistant" ? i : -1)).filter((i) => i >= 0);
    run.step_usage.forEach((s: any, k: number) => {
      if (starts[k] == null) return;
      est.push([estimate([...msgs.slice(0, starts[k]), reminder]) + schema, s.prompt_tokens]);
      bill.push([s.prompt_tokens - (s.cached_tokens || 0), s.cached_tokens || 0, s.completion_tokens, s.cost]);
    });
  }
  const ratios = est.map(([e, p]) => p / e);
  console.log(`[B-2] ${est.length} billed steps: provider prompt_tokens / (estimate + schemas) = ${Math.min(...ratios).toFixed(2)} .. ${Math.max(...ratios).toFixed(2)}`);
  // least squares: cost = a*uncached + b*cached + c*output
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const [u, c, o, y] of bill) {
    const x = [u, c, o];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) A[j][i] += x[j] * x[i];
      A[j][3] += x[j] * y;
    }
  }
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
    }
  }
  const [pu, pc, po] = A.map((row, i) => (row[3] / row[i]) * 1e6);
  console.log(`      fitted prices per 1M tokens: uncached input $${pu.toFixed(3)}, cached input $${pc.toFixed(3)}, output $${po.toFixed(3)} (cached = 1/${(pu / pc).toFixed(0)} of uncached)`);
}
