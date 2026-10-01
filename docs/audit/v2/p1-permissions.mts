// [S-1] Permission decisions for commands that write, delete, execute project
// code or read credentials. Pure: nothing is run.
import os from "node:os";
import path from "node:path";
import { at, offline } from "./_root.mts";
offline();
const { decide, check } = await import(at("src/permissions.ts"));

const posix: Array<[string, string]> = [
  ["rg --pre=rm -e x .", "ripgrep runs --pre COMMAND on every file it searches"],
  ["uniq notes.txt package.json", "uniq INPUT OUTPUT overwrites OUTPUT"],
  ["sort -opackage.json /dev/null", "sort -oFILE (no space)"],
  ["sort --out=package.json /dev/null", "GNU accepts abbreviated --output"],
  ["find . -fprint0 package.json", "find -fprint0 writes a file"],
  ["cat <.env", "input redirect from .env"],
  ["cat .en?", "glob that expands to .env"],
  ["head -c 400 .e''nv", "quote-split .env"],
  ["git diff --no-index /dev/null ~/.npmrc", "reads any file on disk"],
  ["cat ~/.config/gh/hosts.yml", "GitHub CLI token"],
  ["git branch -u origin/main", "rewrites .git/config"],
  ["tree -ofile.txt", "tree -oFILE"],
  ["date -s '2020-01-01'", "sets the clock"],
  ["grep -r sk-or- .", "recursive grep reaches .env (not fixable by patterns)"],
  ["pytest", "runs project code; write_file needs no approval"]
];
console.log("POSIX shell (decide(cmd, posix=true)):");
for (const [cmd, why] of posix) console.log(`  ${decide(cmd, true).padEnd(5)} ${JSON.stringify(cmd).padEnd(42)} ${why}`);
console.log(`  read-only role, pytest: ${decide("pytest", true, true)}   (third argument is ignored before the patch)`);

console.log("PowerShell (decide(cmd, posix=false)):");
for (const cmd of ["Get-Content (Remove-Item -Recurse -Force src)", "echo @(Remove-Item -Recurse src)", "dir (Set-Content -Path x -Value 1)"]) {
  console.log(`  ${decide(cmd, false).padEnd(5)} ${JSON.stringify(cmd)}`);
}
console.log("File tools (check):");
for (const [name, args] of [
  ["grep", { pattern: ".", path: ".env" }],
  ["read_file", { path: ".env" }],
  ["read_file", { path: path.join(os.tmpdir(), "not-a-live-spill.txt") }]
] as const) {
  console.log(`  ${check(name, args as any).action.padEnd(5)} ${name} ${JSON.stringify(args)}`);
}
