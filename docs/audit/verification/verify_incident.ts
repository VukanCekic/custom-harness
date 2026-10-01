/**
 * Replays the real 100%-drop incident (test/run_2026-10-01_17-16-13.json)
 * through the real fit(), and calibrates estimate() against real usage.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "D:/code/coding-harness";
const history = await import(pathToFileURL(path.join(process.env.HARNESS_ROOT || REPO, "src/history.ts")).href);

const run = JSON.parse(fs.readFileSync(path.join(REPO, "test/run_2026-10-01_17-16-13.json"), "utf-8"));
const t: any[] = run.transcript;

// The request that produced the final message (#12) contained #0..#11, with #11
// (the read_file of package.json) still fresh. Restore a realistic fresh body.
const pkg = fs.readFileSync(path.join(REPO, "package.json"), "utf-8");
const prefix = () => {
  const p = structuredClone(t.slice(0, 12));
  p[11].content = pkg;
  return p;
};

const floor = history.estimate(prefix().map((m: any) => (m.role === "tool" ? { ...m, content: `${history.DROPPED} dropped to fit the context window.]` } : m)));
console.log(`non-droppable floor of the incident request: ${floor} est. tokens (system + summary + assistant turns incl. tool-call args)`);
console.log(`breakdown: system=${history.estimate([t[0]])} summary=${history.estimate([t[1]])} assistant+args=${history.estimate(t.slice(2, 12).filter((m: any) => m.role === "assistant"))}`);

for (const W of [3000, 3500, 3700, 4000, 8000]) {
  const msgs = prefix();
  const budget = W * 0.85;
  const res = history.fit(msgs, budget);
  const dropped = typeof res === "number" ? res : `${res.dropped} (stubbed ${res.stubbed}, squeezed ${res.squeezed}, fits=${res.fits}, floor=${res.floor})`;
  const after = history.estimate(msgs);
  const fresh = String(msgs[11].content).startsWith(history.DROPPED);
  console.log(
    `CONTEXT_WINDOW=${String(W).padEnd(5)} budget=${String(budget).padEnd(6)} dropped=${dropped} fresh-result-dropped=${fresh} ` +
      `est.after=${after} ${after > budget ? "STILL OVER BUDGET (unreachable target)" : "fits"}`
  );
}

// -------- estimate() calibration against provider-reported prompt_tokens --------
// For runs whose final step had no tool calls, the final request was
// transcript[0..n-2] + reminder + tool schemas. Fit P = a*E + b by least squares.
const files = fs.readdirSync(path.join(REPO, "test")).filter((f) => f.startsWith("run_") && f.endsWith(".json"));
const pts: Array<{ f: string; E: number; P: number; date: string }> = [];
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(REPO, "test", f), "utf-8"));
  const tr: any[] = r.transcript || [];
  const last = tr[tr.length - 1];
  if (!r.usage?.prompt_tokens || last?.role !== "assistant" || last.toolCalls?.length) continue;
  // skip runs whose transcript was rewritten after the request (strip/compaction)
  if (tr.some((m) => typeof m.content === "string" && (m.content.includes("[output stripped:") || m.content.includes("<summary>")))) continue;
  pts.push({ f, E: history.estimate(tr.slice(0, -1)), P: r.usage.prompt_tokens, date: f.slice(4, 14) });
}
const n = pts.length;
const mx = pts.reduce((a, p) => a + p.E, 0) / n;
const my = pts.reduce((a, p) => a + p.P, 0) / n;
const a = pts.reduce((s, p) => s + (p.E - mx) * (p.P - my), 0) / pts.reduce((s, p) => s + (p.E - mx) ** 2, 0);
const b = my - a * mx;
const ss = pts.reduce((s, p) => s + (p.P - (a * p.E + b)) ** 2, 0);
const st = pts.reduce((s, p) => s + (p.P - my) ** 2, 0);
console.log(`\nestimate() calibration over ${n} clean runs: prompt_tokens ~= ${a.toFixed(3)} * estimate + ${b.toFixed(0)}  (R^2=${(1 - ss / st).toFixed(3)})`);
const ratios = pts.map((p) => p.P / p.E).sort((x, y) => x - y);
console.log(`raw ratio prompt_tokens/estimate: min=${ratios[0].toFixed(2)} median=${ratios[Math.floor(n / 2)].toFixed(2)} max=${ratios[n - 1].toFixed(2)}`);
for (const p of pts.sort((x, y) => y.E - x.E).slice(0, 6)) console.log(`  ${p.f}: estimate=${p.E} actual=${p.P} ratio=${(p.P / p.E).toFixed(2)}`);

// -------- cache hit ratio on the final step of every run --------
let P = 0, C = 0;
const multi: string[] = [];
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(REPO, "test", f), "utf-8"));
  if (!r.usage?.prompt_tokens) continue;
  P += r.usage.prompt_tokens;
  C += r.usage.cached_tokens || 0;
  if ((r.transcript || []).length > 9) multi.push(`${f.slice(4, 23)}=${((100 * (r.usage.cached_tokens || 0)) / r.usage.prompt_tokens).toFixed(0)}%`);
}
console.log(`\nfinal-step prompt-cache hit ratio across all runs: ${((100 * C) / P).toFixed(1)}% (${C}/${P})`);
console.log(`multi-step runs: ${multi.join(" ")}`);
