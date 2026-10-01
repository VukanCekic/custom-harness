import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";

const LABELS: Record<string, string> = {
  M: "modified",
  D: "deleted",
  A: "added",
  "??": "new"
};

function git(command: string): string {
  try {
    return execSync(`git ${command}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
  } catch {
    return "";
  }
}

function fileHash(filePath: string): string | null {
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const data = fs.readFileSync(fullPath);
      return crypto.createHash("md5").update(data).digest("hex");
    }
  } catch {}
  return null;
}

function gitState(): Record<string, [string, string | null]> {
  const state: Record<string, [string, string | null]> = {};
  const output = git("status --porcelain");
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    const filePath = line.slice(3).trim();
    state[filePath] = [status, fileHash(filePath)];
  }
  return state;
}

let lastState = gitState();

/**
 * Files whose status or contents moved since the previous step.
 */
export function fileChanges(): Record<string, string> {
  const now = gitState();
  const changed: Record<string, string> = {};
  for (const [filePath, val] of Object.entries(now)) {
    const lastVal = lastState[filePath];
    if (!lastVal || lastVal[0] !== val[0] || lastVal[1] !== val[1]) {
      changed[filePath] = val[0];
    }
  }
  lastState = now;
  return changed;
}

export function changesNote(): string {
  const changed = fileChanges();
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

// path -> mtime when the agent last read/wrote it
const SEEN = new Map<string, number>();

/**
 * Records when a file was accessed/inspected by the agent.
 */
export function noteRead(filePath: string): void {
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
    if (fs.existsSync(fullPath)) {
      SEEN.set(filePath, fs.statSync(fullPath).mtimeMs);
    }
  } catch {}
}

/**
 * Returns files that changed on disk since the agent last read them.
 */
export function staleFiles(): string[] {
  const stale: string[] = [];
  for (const [filePath, mtime] of SEEN.entries()) {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      if (fs.existsSync(fullPath)) {
        const currentMtime = fs.statSync(fullPath).mtimeMs;
        if (currentMtime !== mtime) {
          stale.push(filePath);
        }
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

let todosProvider: (() => string) | null = null;

export function setTodosProvider(provider: (() => string) | null): void {
  todosProvider = provider;
}

export function todosNote(): string {
  const plan = todosProvider ? todosProvider() : "";
  return plan ? `\n<todos>\n${plan}\n</todos>` : "";
}

/**
 * Resets context tracking for a fresh session.
 */
export function resetContextState(): void {
  lastState = gitState();
  SEEN.clear();
}

/**
 * Late injection: a small block appended to messages just before sending to LLM.
 * Appended at the end of the message list so the prefix in front of it stays cached.
 */
export function reminder(): ChatMessages {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const branch = git("branch --show-current").trim() || "(detached)";

  const content =
    "<env>\n" +
    `time: ${timeStr}\n` +
    `git branch: ${branch}\n` +
    "</env>" +
    todosNote() +
    changesNote() +
    staleNote();

  return {
    role: "user",
    content
  };
}
