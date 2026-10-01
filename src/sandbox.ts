import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { current } from "./scope.js";

const OUTPUT_LIMIT = 10 * 1024 * 1024;

/**
 * Resolve symlinks and junctions on the deepest part of the path that exists.
 * A lexical path.resolve let `link/evil.txt` pass as "inside the project"
 * while `link` pointed somewhere else entirely.
 */
function real(target: string, base = process.cwd()): string {
  let current = path.resolve(base, target);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  try {
    current = fs.realpathSync.native(current);
  } catch {
    // keep the lexical path
  }
  return path.join(current, ...rest);
}

export const PROJECT_ROOT = real(process.cwd());

// /dev/null is on the list because almost every command a model writes ends
// in 2>/dev/null, and a profile without it fails all of them.
const PROFILE = `(version 1)
(deny default)
(allow process-exec process-fork signal)
(allow file-read*)
(allow sysctl-read)
(deny network*)
(allow file-write* (subpath "${PROJECT_ROOT}") (literal "/dev/null"))
(deny file-write* (subpath "${path.join(PROJECT_ROOT, ".git")}"))
`;

/**
 * Check if bubblewrap is available on Linux.
 *
 * This used to call require() - which does not exist in an ES module. The
 * ReferenceError landed in the catch below, so bwrap was never found and every
 * command ran unsandboxed while nothing said so.
 */
function hasBwrap(): boolean {
  try {
    execSync("command -v bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Git for Windows' bash, if installed. The tool is called bash, and the model writes bash. */
function windowsBash(): string | null {
  const candidates = [
    process.env.BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Which syntax the bash tool really speaks - permissions parse commands accordingly. */
export function shellKind(): "posix" | "powershell" {
  return process.platform === "win32" && !windowsBash() ? "powershell" : "posix";
}

/**
 * Returns the name of the sandbox enforcement mechanism.
 */
export function name(): string {
  if (process.env.SANDBOX_NAME) {
    return process.env.SANDBOX_NAME;
  }
  if (process.platform === "darwin") {
    return "seatbelt";
  }
  if (process.platform === "linux" && hasBwrap()) {
    return "bubblewrap";
  }
  // Windows has no OS sandbox here. Reporting "windows" implied one.
  return "none";
}

/**
 * Returns whether a given path is inside the project and not inside .git.
 */
export function insideProject(targetPath: string): boolean {
  try {
    const resolved = real(targetPath, PROJECT_ROOT);
    const relative = path.relative(PROJECT_ROOT, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    // Block access to .git
    const relGit = path.relative(path.join(PROJECT_ROOT, ".git"), resolved);
    if (!relGit.startsWith("..") && !path.isAbsolute(relGit)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a shell command in an OS sandbox if available. None means native runner.
 */
export function wrap(command: string): string[] | null {
  if (process.platform === "darwin") {
    const profilePath = path.join(os.tmpdir(), "neuralcode.sb");
    fs.writeFileSync(profilePath, PROFILE, "utf-8");
    return ["sandbox-exec", "-f", profilePath, "/bin/sh", "-c", command];
  }

  if (process.platform === "linux" && hasBwrap()) {
    // Same policy as the macOS profile: the project is writable, its .git is not.
    const gitDir = path.join(PROJECT_ROOT, ".git");
    const protectGit = fs.existsSync(gitDir) ? ["--ro-bind", gitDir, gitDir] : [];
    return [
      "bwrap",
      "--ro-bind", "/", "/",
      "--bind", PROJECT_ROOT, PROJECT_ROOT,
      ...protectGit,
      "--dev", "/dev",
      "--proc", "/proc",
      "--unshare-net",
      "--die-with-parent",
      "/bin/sh", "-c", command
    ];
  }

  return null;
}

/**
 * The child gets our environment minus the harness's own credentials:
 * dotenv puts the API key in process.env, and `env` would print it.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["OPENROUTER_API_KEY", ...(process.env.SCRUB_ENV || "").split(",")]) {
    if (key.trim()) delete env[key.trim()];
  }
  return env;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Stop a command and everything it started. Killing just the shell left its
 * children running on Windows - a timed-out `npm test` kept its node workers,
 * a cancelled dev server kept its port.
 */
function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode != null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // the process group spawn() gave it
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Runs a command within project boundary, sandboxed when the OS lets us.
 * Rejects (like exec) on a non-zero exit, a timeout, or runaway output.
 */
export async function run(command: string, timeout = 60000): Promise<RunResult> {
  const sandboxed = wrap(command);
  // Ctrl+C or a subagent's time limit kills the command, not just the wait for it.
  const signal = current().signal;
  const shell =
    process.platform === "win32"
      ? windowsBash() || "powershell.exe"
      : process.env.SHELL || "/bin/sh";
  const [file, args] = sandboxed ? [sandboxed[0], sandboxed.slice(1)] : [shell, ["-c", command]];

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: PROJECT_ROOT,
      env: childEnv(),
      windowsHide: true,
      detached: process.platform !== "win32" // its own process group, so killTree reaches its children
    });
    // Nothing is ever typed into a command: a bare `cat` gets EOF, not a 60s wait.
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "cancel" | "output" | null = null;
    const stop = (why: NonNullable<typeof stopped>) => {
      if (stopped) return;
      stopped = why;
      killTree(child);
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    const onAbort = () => stop("cancel");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (target: "stdout" | "stderr") => (data: Buffer) => {
      if (target === "stdout") stdout += data.toString();
      else stderr += data.toString();
      if (stdout.length + stderr.length > OUTPUT_LIMIT) stop("output");
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("close", (code, killedBy) => {
      settle();
      if (stopped === "cancel") {
        return reject(Object.assign(new Error("cancelled"), { name: "AbortError", stdout, stderr }));
      }
      if (code === 0 && !stopped) return resolve({ stdout, stderr, code });
      const how = stopped ? `${stopped === "timeout" ? "a timeout" : "too much output"}` : killedBy ? `signal ${killedBy}` : `exit code ${code}`;
      reject(Object.assign(new Error(`Command failed with ${how}`), {
        stdout, stderr, code, signal: killedBy ?? (stopped ? "SIGTERM" : null), killed: stopped != null || killedBy != null
      }));
    });
    child.on("error", (err) => {
      settle();
      reject(err);
    });
  });
}
