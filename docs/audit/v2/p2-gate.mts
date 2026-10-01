// [S-2] The bypasses, executed for real through the shared gate with NO
// approver - exactly how a read-only planner or researcher runs - inside a
// throwaway directory. Files named victim*.txt start as "IMPORTANT DATA".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { at, offline } from "./_root.mts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-probe-"));
process.chdir(dir);
offline();
const { execute } = await import(at("src/execute.ts"));
const { bashTool } = await import(at("src/tools/bash.ts"));
const { grepTool } = await import(at("src/tools/search.ts"));
const write = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);
const read = (f: string) => JSON.stringify(fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 40));
const call = (name: string, args: object) => ({ id: "c", type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const gate = { tools: { bash: bashTool, grep: grepTool } }; // no approve: an "ask" is refused

for (const [cmd, victim] of [
  ["sort --out=victim1.txt in.txt", "victim1.txt"],
  ["uniq in.txt victim2.txt", "victim2.txt"],
  ["find . -name in.txt -fprint0 victim3.txt", "victim3.txt"]
] as const) {
  write(victim, "IMPORTANT DATA\n");
  write("in.txt", "b\na\n");
  const { result } = await execute(call("bash", { command: cmd }), gate);
  console.log(`${cmd.padEnd(42)} gate: ${result.split("\n")[0].slice(0, 60).padEnd(60)} ${victim} now ${read(victim)}`);
}
write(".env", "OPENROUTER_API_KEY=sk-or-v1-FAKE-SECRET-FOR-PROBE\n");
for (const cmd of ["cat <.env", "cat .en?", "cat .env"]) {
  console.log(`${cmd.padEnd(42)} -> ${(await execute(call("bash", { command: cmd }), gate)).result.trim().slice(0, 90)}`);
}
console.log(`${'grep tool, path ".env"'.padEnd(42)} -> ${(await execute(call("grep", { pattern: "KEY", path: ".env" }), gate)).result.trim().slice(0, 90)}`);
process.chdir(os.tmpdir());
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} // Windows may still hold it briefly
