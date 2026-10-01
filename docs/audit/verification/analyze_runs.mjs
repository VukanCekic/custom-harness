// Mine recorded run transcripts for context-management evidence.
import fs from "node:fs";
import path from "node:path";

const dir = "D:/code/coding-harness/test";
const files = fs.readdirSync(dir).filter((f) => f.startsWith("run_") && f.endsWith(".json")).sort();

const DROPPED = "[output dropped:";
const STRIPPED = "[output stripped:";
const TRIMMED = "[output trimmed:";
const SUMMARY = "<summary>";

const rows = [];
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  const t = Array.isArray(rec.transcript) ? rec.transcript : [];
  const tools = t.filter((m) => m.role === "tool");
  const str = (m) => (typeof m.content === "string" ? m.content : "");
  const dropped = tools.filter((m) => str(m).includes(DROPPED)).length;
  const stripped = tools.filter((m) => str(m).includes(STRIPPED)).length;
  const trimmed = tools.filter((m) => str(m).includes(TRIMMED)).length;
  // where does "<summary>" appear? (role + index)
  const summaryHits = t
    .map((m, i) => ({ i, role: m.role, has: str(m).includes(SUMMARY) }))
    .filter((x) => x.has)
    .map((x) => `${x.role}@${x.i}`);
  // derive locked() exactly like history.ts
  let lockedIdx = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (str(t[i]).includes(SUMMARY)) { lockedIdx = i + 1; break; }
  }
  const estimate = Math.floor(t.reduce((a, m) => a + JSON.stringify(m).length, 0) / 4);
  const assistantToolArgChars = t
    .filter((m) => m.role === "assistant")
    .reduce((a, m) => a + (m.toolCalls || []).reduce((b, c) => b + (c.function?.arguments?.length || 0), 0), 0);
  const toolChars = tools.reduce((a, m) => a + str(m).length, 0);
  const u = rec.usage || {};
  const toolNames = {};
  for (const m of t) for (const c of m.toolCalls || []) toolNames[c.function?.name] = (toolNames[c.function?.name] || 0) + 1;
  rows.push({
    file: f.replace("run_", "").replace(".json", ""),
    model: rec.model,
    steps: rec.steps,
    msgs: t.length,
    tools: tools.length,
    dropped, stripped, trimmed,
    summaryHits: summaryHits.join(",") || "-",
    lockedIdx,
    estimate,
    toolChars,
    argChars: assistantToolArgChars,
    prompt_tokens: u.prompt_tokens ?? null,
    cached: u.cached_tokens ?? null,
    cost: u.cost ?? null,
    prompt: String(rec.prompt || "").replace(/\s+/g, " ").slice(0, 60),
    toolNames: Object.entries(toolNames).map(([k, v]) => `${k}:${v}`).join(" "),
  });
}

console.log(["file", "model", "steps", "msgs", "tools", "drop", "strip", "trim", "summaryHits", "lock", "est", "toolChars", "argChars", "pTok", "cached", "cost"].join("\t"));
for (const r of rows) {
  console.log([r.file, r.model, r.steps, r.msgs, r.tools, r.dropped, r.stripped, r.trimmed, r.summaryHits, r.lockedIdx, r.estimate, r.toolChars, r.argChars, r.prompt_tokens, r.cached, r.cost].join("\t"));
}
console.log("\n--- prompts & tool usage ---");
for (const r of rows) console.log(`${r.file} | ${r.prompt} | ${r.toolNames}`);

const tot = rows.reduce((a, r) => ({ tools: a.tools + r.tools, dropped: a.dropped + r.dropped, stripped: a.stripped + r.stripped, trimmed: a.trimmed + r.trimmed }), { tools: 0, dropped: 0, stripped: 0, trimmed: 0 });
console.log("\nTOTALS", tot);
console.log("runs with any drop:", rows.filter((r) => r.dropped > 0).map((r) => `${r.file}(${r.dropped}/${r.tools})`).join(" "));
console.log("runs where 100% of tool results dropped:", rows.filter((r) => r.tools > 0 && r.dropped === r.tools).map((r) => r.file).join(" ") || "none");
console.log("runs with <summary> in a NON-handoff message:", rows.filter((r) => r.summaryHits !== "-" && !/^user@1$/.test(r.summaryHits)).map((r) => `${r.file}[${r.summaryHits}]`).join(" ") || "none");
