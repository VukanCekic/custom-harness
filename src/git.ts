/**
 * Git, as the harness itself uses it - never through the model's shell.
 *
 * Everything here is bounded by a timeout and returns "" rather than throwing:
 * a project that is not a repository, or a git that hangs on a lock file,
 * must not take a turn down with it.
 */

import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 5_000;

export interface GitOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function git(args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeout ?? TIMEOUT_MS,
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout) => resolve(err ? "" : String(stdout))
    );
  });
}

export function gitSync(args: string[], options: GitOptions = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeout ?? TIMEOUT_MS,
      env: options.env ?? process.env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
  } catch {
    return "";
  }
}

/** Absolute path of the repository root, or null outside a repository. */
export async function repoRoot(): Promise<string | null> {
  const out = (await git(["rev-parse", "--show-toplevel"])).trim();
  return out ? path.resolve(out) : null;
}

/**
 * A tree object holding the working directory exactly as it is now -
 * modified, staged and untracked files alike, .gitignore respected.
 *
 * Built in a throwaway index, so the user's own staging area is never touched.
 * `git diff` alone cannot do this: it does not show untracked files, which
 * is every file a worker creates.
 */
export async function snapshot(): Promise<string | null> {
  const root = await repoRoot();
  if (!root) return null;
  const index = path.join(os.tmpdir(), `customharness-index-${crypto.randomBytes(4).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root })).trim();
    if (head) await git(["read-tree", head], { cwd: root, env });
    await git(["add", "-A", "--", "."], { cwd: root, env, timeout: 30_000 });
    const tree = (await git(["write-tree"], { cwd: root, env })).trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Short status of the working tree, for reports about what a run changed. */
export async function shortStatus(): Promise<string> {
  return (await git(["status", "--short"])).trimEnd();
}
