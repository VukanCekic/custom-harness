import fs from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const PROJECT_ROOT = path.resolve(process.cwd());

const PROFILE = `(version 1)
(deny default)
(allow process-exec process-fork signal)
(allow file-read*)
(allow sysctl-read)
(deny network*)
(allow file-write* (subpath "${PROJECT_ROOT}"))
(deny file-write* (subpath "${path.join(PROJECT_ROOT, ".git")}"))
`;

/**
 * Check if bubblewrap is available on Linux.
 */
function hasBwrap(): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync("which bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
  if (process.platform === "win32") {
    return "windows";
  }
  return "none";
}

/**
 * Returns whether a given path is inside the project and not inside .git.
 */
export function insideProject(targetPath: string): boolean {
  try {
    const resolved = path.resolve(PROJECT_ROOT, targetPath);
    const relative = path.relative(PROJECT_ROOT, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }
    // Block access to .git
    const gitDir = path.join(PROJECT_ROOT, ".git");
    const relGit = path.relative(gitDir, resolved);
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
    const os = require("node:os");
    const profilePath = path.join(os.tmpdir(), "neuralcode.sb");
    fs.writeFileSync(profilePath, PROFILE, "utf-8");
    return ["sandbox-exec", "-f", profilePath, "/bin/sh", "-c", command];
  }

  if (process.platform === "linux" && hasBwrap()) {
    return [
      "bwrap",
      "--ro-bind", "/", "/",
      "--bind", PROJECT_ROOT, PROJECT_ROOT,
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
 * Runs a command within project boundary, sandboxed when the OS lets us.
 */
export async function run(
  command: string,
  timeout = 60000
): Promise<{ stdout: string; stderr: string }> {
  const sandboxed = wrap(command);

  if (sandboxed) {
    return new Promise((resolve, reject) => {
      const child = spawn(sandboxed[0], sandboxed.slice(1), {
        cwd: PROJECT_ROOT,
        timeout
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", () => {
        resolve({ stdout, stderr });
      });

      child.on("error", (err) => {
        reject(err);
      });
    });
  }

  // Windows / default execution
  const shell =
    process.platform === "win32"
      ? "powershell.exe"
      : process.env.SHELL || "/bin/sh";

  return execAsync(command, {
    cwd: PROJECT_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    shell
  });
}
