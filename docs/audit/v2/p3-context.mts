// [C-1] strip()/fit() against a result that merely CONTAINS a marker string
// (reading src/history.ts does). [C-2] paging a capped read_file result.
// [C-3] what estimate() assumes about scripts. Pure, no network.
import fs from "node:fs";
import path from "node:path";
import { at, offline, ROOT } from "./_root.mts";
offline();
const H = await import(at("src/history.ts"));
const { readFileTool } = await import(at("src/tools/readFile.ts"));
const { fit, strip, estimate, cap, sweep, STRIPPED, DROPPED } = H;

const src = fs.readFileSync(path.join(ROOT, "src", "history.ts"), "utf-8");
const numbered = src.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n");
console.log(`src/history.ts contains "${STRIPPED}": ${src.includes(STRIPPED)}, "${DROPPED}": ${src.includes(DROPPED)}`);
const tool = (content: string, id: string) => ({ role: "tool", toolCallId: id, content }) as any;
const asked = (id: string) => ({ role: "assistant", content: "", toolCalls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] }) as any;

const turn: any[] = [{ role: "system", content: "s" }, { role: "user", content: "explain" }, asked("1"), tool(cap(numbered), "1"), { role: "assistant", content: "ok" }];
const before = turn[3].content.length;
const shrunk = strip(turn);
console.log(`[C-1a] strip() at the end of the turn: ${shrunk} result(s) shrunk; ${before} -> ${turn[3].content.length} chars`);

const m: any[] = [{ role: "system", content: "s" }, { role: "user", content: "go" },
  asked("1"), tool(cap(numbered), "1"),
  asked("2"), tool("x".repeat(6000), "2"),
  asked("3"), tool("y".repeat(900), "3")];
const total = estimate(m);
const budget = total - 1500;
const snap = JSON.stringify(m);
const r = fit(m, budget, 0);
console.log(`[C-1b] fit(): request ~${total} tokens, budget ${budget}: fits=${r.fits}, reported floor ${r.floor}, ` +
  `tokens after ${r.tokens}; transcript ${JSON.stringify(m) === snap ? "untouched" : "MODIFIED"}`);
sweep();

const big = await readFileTool.execute({ path: path.join(ROOT, "README.md") });
const capped = cap(big);
const spill = capped.match(/The whole output is at (.+?) - page through/)?.[1];
if (spill) {
  const paged = await readFileTool.execute({ path: spill, offset: 105, limit: 2 });
  console.log(`[C-2] README.md read: ${big.length} chars -> capped and spilled; paging the spill gives:\n${paged.split("\n").slice(0, 3).join("\n")}`);
} else {
  console.log(`[C-2] README.md read comes back paged, no spill: ${big.split("\n")[0]}`);
}
sweep();

for (const [label, s] of [
  ["English", "The quick brown fox jumps over the lazy dog. ".repeat(20)],
  ["Serbian Cyrillic", "Брза смеђа лисица скаче преко лењог пса. ".repeat(20)],
  ["Chinese", "敏捷的棕色狐狸跳过了懒狗。".repeat(20)]
] as const) {
  console.log(`[C-3] ${label.padEnd(16)} ${String(s.length).padStart(4)} chars -> estimate ${estimate([{ role: "user", content: s } as any])} tokens`);
}
