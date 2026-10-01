// [R-1] The grep tool runs model-written regexes on the main thread: the event
// loop (spinner, Ctrl+C, the stall watchdog) is frozen while it runs.
// [R-2] Does a timed-out command take its child processes with it?
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { at, offline } from "./_root.mts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-probe-"));
process.chdir(dir);
offline();
const { grepTool } = await import(at("src/tools/search.ts"));
const { run } = await import(at("src/sandbox.ts"));

for (const n of [20, 22, 24, 26]) {
  fs.writeFileSync(path.join(dir, "data.txt"), "x".repeat(n) + "\n");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const t0 = performance.now();
  await grepTool.execute({ pattern: "(x+x+)+y", path: "data.txt" });
  const ms = performance.now() - t0;
  clearInterval(timer);
  console.log(`[R-1] grep /(x+x+)+y/ over one ${n}-char line: ${ms.toFixed(0).padStart(5)} ms, event-loop ticks meanwhile: ${ticks} (a free loop: ~${Math.floor(ms / 10)})`);
}

const pidFile = path.join(dir, "child.pid").replace(/\\/g, "/");
const t0 = Date.now();
try {
  await run(`node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(()=>{}, 15000)" ; true`, 2000);
} catch (err: any) {
  console.log(`[R-2] command stopped after ${Date.now() - t0} ms (${err.signal || err.code || err.message})`);
}
await new Promise((r) => setTimeout(r, 500));
const pid = Number(fs.readFileSync(pidFile, "utf-8"));
let alive = false;
try { process.kill(pid, 0); alive = true; } catch {}
console.log(`      its child (pid ${pid}) is ${alive ? "STILL RUNNING - killed by this probe now" : "gone"}`);
if (alive) { try { process.platform === "win32" ? execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }) : process.kill(pid); } catch {} }
process.chdir(os.tmpdir());
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} // Windows may still hold it briefly
