import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { git, gitSync } from "./git.js";
import { todosPrompt, clearTodos } from "./todos.js";

const LABELS: Record<string, string> = {
  M: "modified",
  D: "deleted",
  A: "added",
  "??": "new"
};

const HASH_LIMIT = 1024 * 1024; // bigger files are compared by size and mtime only
const STATUS_TIMEOUT_MS = 2_000;

/**
 * One spelling per file. On Windows the same directory can arrive as an 8.3
 * short name (C:\Users\RUNNER~1\...) from the cwd or TEMP and as the long name
 * from git; compared as strings they never matched, so the agent's own writes
 * came back as outside changes. The deepest existing part is resolved through
 * the filesystem, so files that do not exist yet (or were deleted) still map.
 */
function canonical(target: string): string {
  let current = path.resolve(target);
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

const key = (filePath: string) => canonical(path.resolve(process.cwd(), filePath));
const shown = (fullPath: string) => path.relative(canonical(process.cwd()), fullPath) || fullPath;

/** Content fingerprint; for big files size + mtime, which is cheap and good enough. */
function fingerprint(fullPath: string): string | null {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;
    if (stat.size > HASH_LIMIT) return `size:${stat.size}:mtime:${stat.mtimeMs}`;
    return crypto.createHash("md5").update(fs.readFileSync(fullPath)).digest("hex");
  } catch {
    return null;
  }
}

type GitState = Record<string, [string, string | null]>;

function parseStatus(output: string, root: string): GitState {
  const state: GitState = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    // porcelain paths are relative to the repository root, not to cwd
    const relative = line.slice(3).trim().replace(/^"|"$/g, "").split(" -> ").pop()!;
    const fullPath = path.resolve(root, relative);
    state[fullPath] = [status, fingerprint(fullPath)];
  }
  return state;
}

const TOP = gitSync(["rev-parse", "--show-toplevel"]).trim();
const ROOT = TOP ? canonical(TOP) : "";
let lastState: GitState = ROOT ? parseStatus(gitSync(["status", "--porcelain"]), ROOT) : {};

// fingerprint of each file as the agent itself last wrote it
const WROTE = new Map<string, string | null>();

/**
 * Files whose status or contents moved since the previous step - other than
 * by the agent's own hand. Its own edits used to come back as "changed,
 * read them again", which taught it to re-read every file it had just written.
 */
export async function fileChanges(): Promise<Record<string, string>> {
  if (!ROOT) return {};
  const output = await git(["status", "--porcelain"], { timeout: STATUS_TIMEOUT_MS, cwd: ROOT });
  const now = parseStatus(output, ROOT);
  const changed: Record<string, string> = {};
  for (const [fullPath, val] of Object.entries(now)) {
    const lastVal = lastState[fullPath];
    if (lastVal && lastVal[0] === val[0] && lastVal[1] === val[1]) continue;
    if (WROTE.has(fullPath) && WROTE.get(fullPath) === val[1]) continue;
    changed[shown(fullPath)] = val[0];
  }
  lastState = now;
  return changed;
}

export async function changesNote(): Promise<string> {
  const changed = await fileChanges();
  const entries = Object.entries(changed);
  if (entries.length === 0) return "";
  const lines = entries.map(([p, code]) => `${LABELS[code] || code}: ${p}`);
  return (
    "\n<system-reminder>\n" +
    "These files changed since your last turn. Read them again before editing:\n" +
    lines.join("\n") +
    "\n</system-reminder>"
  );
}

// full path -> mtime when the agent last read/wrote it
const SEEN = new Map<string, number>();
// full path -> the mtime we already warned about, so each change is reported once
const WARNED = new Map<string, number>();

/**
 * Records when a file was accessed/inspected by the agent.
 */
export function noteRead(filePath: string): void {
  try {
    const fullPath = key(filePath);
    if (fs.existsSync(fullPath)) {
      SEEN.set(fullPath, fs.statSync(fullPath).mtimeMs);
      WARNED.delete(fullPath);
    }
  } catch {}
}

/** The agent wrote this file: it has seen it, and the change is its own. */
export function noteWrite(filePath: string): void {
  noteRead(filePath);
  const fullPath = key(filePath);
  WROTE.set(fullPath, fingerprint(fullPath));
}

/**
 * Returns files that changed on disk since the agent last read them, and
 * that it has not been told about yet.
 */
export function staleFiles(): string[] {
  const stale: string[] = [];
  for (const [fullPath, mtime] of SEEN.entries()) {
    try {
      if (!fs.existsSync(fullPath)) continue;
      const currentMtime = fs.statSync(fullPath).mtimeMs;
      if (currentMtime !== mtime && WARNED.get(fullPath) !== currentMtime) {
        WARNED.set(fullPath, currentMtime);
        stale.push(shown(fullPath));
      }
    } catch {}
  }
  return stale;
}

export function staleNote(): string {
  const changed = staleFiles();
  if (changed.length === 0) return "";
  return (
    "\n<system-reminder>\n" +
    "These files changed on disk since you read them. Read them again before editing:\n" +
    changed.join("\n") +
    "\n</system-reminder>"
  );
}

export function todosNote(): string {
  const plan = todosPrompt();
  return plan ? `\n<todos>\n${plan}\n</todos>` : "";
}

/**
 * Resets context tracking for a fresh session.
 */
export function resetContextState(): void {
  lastState = ROOT ? parseStatus(gitSync(["status", "--porcelain"]), ROOT) : {};
  SEEN.clear();
  WARNED.clear();
  WROTE.clear();
  clearTodos();
}

/**
 * Late injection: a small block appended to messages just before sending to LLM.
 * Appended at the end of the message list so the prefix in front of it stays cached.
 */
export async function reminder(): Promise<ChatMessages> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const [branch, changes] = await Promise.all([
    ROOT ? git(["branch", "--show-current"], { timeout: STATUS_TIMEOUT_MS }) : Promise.resolve(""),
    changesNote()
  ]);

  const content =
    "<env>\n" +
    `time: ${timeStr}\n` +
    `git branch: ${branch.trim() || (ROOT ? "(detached)" : "(not a git repository)")}\n` +
    "</env>" +
    todosNote() +
    changes +
    staleNote();

  return {
    role: "user",
    content
  };
}
