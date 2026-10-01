/**
 * Sessions: an append-only JSONL log per conversation, outside the project.
 *
 * Every message is appended the moment it joins the transcript, so a crash
 * mid-turn loses at most the line being written - and the loader skips a
 * half-written last line. Compaction and /rewind are records of their own
 * ("replace", "rewind"), so the log is never rewritten in place.
 *
 * Logs live in ~/.agents/sessions/<project>/ (SESSION_DIR overrides). They
 * used to be written into the project's own test/ directory - the folder the
 * agent was working on, where it could read, edit or commit them.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import { HANDOFF_OPENING } from "./history.js";

export type SessionRecord =
  | { type: "meta"; version: 1; id: string; cwd: string; model: string; created: string }
  | { type: "message"; message: ChatMessages }
  | { type: "replace"; reason: string; messages: ChatMessages[] }
  | { type: "rewind"; keep: number }
  | { type: "turn"; [key: string]: unknown };

/** This project's session directory. */
export function sessionDir(cwd = process.cwd()): string {
  if (config.sessionDir) return path.resolve(config.sessionDir);
  const resolved = path.resolve(cwd);
  const slug = `${path.basename(resolved) || "root"}-${crypto.createHash("sha1").update(resolved.toLowerCase()).digest("hex").slice(0, 8)}`;
  return path.join(os.homedir(), ".agents", "sessions", slug.replace(/[^\w.-]/g, "_"));
}

function stamp(date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  );
}

export interface Loaded {
  messages: ChatMessages[];
  meta: Extract<SessionRecord, { type: "meta" }> | null;
  turns: number;
  /** Lines that could not be parsed - a crash mid-write leaves at most one. */
  skipped: number;
}

/** Replay a log into a transcript. */
export function load(file: string): Loaded {
  const out: Loaded = { messages: [], meta: null, turns: 0, skipped: 0 };
  const text = fs.readFileSync(file, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: SessionRecord;
    try {
      record = JSON.parse(line);
    } catch {
      out.skipped++;
      continue;
    }
    switch (record.type) {
      case "meta":
        out.meta = record;
        break;
      case "message":
        out.messages.push(record.message);
        break;
      case "replace":
        out.messages = [...record.messages];
        break;
      case "rewind":
        out.messages.length = Math.min(out.messages.length, Math.max(1, record.keep));
        break;
      case "turn":
        out.turns++;
        break;
    }
  }
  return out;
}

export interface SessionInfo {
  file: string;
  id: string;
  modified: Date;
  messages: number;
  firstRequest: string;
}

/** This project's sessions, newest first. */
export function listSessions(dir = sessionDir()): SessionInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const loaded = load(file);
      const first = loaded.messages.find(
        (m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(HANDOFF_OPENING)
      );
      out.push({
        file,
        id: name.replace(/\.jsonl$/, ""),
        modified: fs.statSync(file).mtime,
        messages: loaded.messages.length,
        firstRequest: typeof first?.content === "string" ? first.content : ""
      });
    } catch {
      // unreadable log - leave it out of the list
    }
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export class Session {
  readonly file: string;
  readonly id: string;
  private written = 0;

  private constructor(file: string, written: number) {
    this.file = file;
    this.id = path.basename(file, ".jsonl");
    this.written = written;
  }

  /** A new, empty log. */
  static create(dir = sessionDir()): Session {
    fs.mkdirSync(dir, { recursive: true });
    const id = stamp();
    const session = new Session(path.join(dir, `${id}.jsonl`), 0);
    session.append({ type: "meta", version: 1, id, cwd: process.cwd(), model: config.model, created: new Date().toISOString() });
    return session;
  }

  /** Continue an existing log. `messages` is what it was loaded into. */
  static resume(file: string, messages: ChatMessages[]): Session {
    // A crash can leave a half-written last line. Terminate it, or the next
    // record would be glued onto it and lost along with it.
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (text && !text.endsWith("\n")) fs.appendFileSync(file, "\n", "utf-8");
    return new Session(file, messages.length);
  }

  private append(record: SessionRecord): void {
    // One synchronous write per record: when this returns, the line is on disk.
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf-8");
  }

  /**
   * Bring the log up to date with the transcript. New messages are appended.
   * A transcript that got shorter was compacted or rewound, so it is
   * recorded whole. (strip and fit edit old messages in place; the loader
   * re-applies them, so they are not logged.)
   */
  sync(messages: ChatMessages[]): void {
    if (messages.length < this.written) {
      this.replace(messages, "compaction");
      return;
    }
    for (let index = this.written; index < messages.length; index++) {
      this.append({ type: "message", message: messages[index] });
    }
    this.written = messages.length;
  }

  replace(messages: ChatMessages[], reason: string): void {
    this.append({ type: "replace", reason, messages });
    this.written = messages.length;
  }

  rewind(keep: number): void {
    this.append({ type: "rewind", keep });
    this.written = keep;
  }

  /** End-of-turn telemetry: usage per step, cache, compactions, cost by role. */
  turn(data: Record<string, unknown>): void {
    this.append({ type: "turn", at: new Date().toISOString(), ...data });
  }
}

/**
 * The newest saved transcript from before sessions existed, so --resume
 * still finds work recorded in the old test/run_*.json files.
 */
export function legacyTranscript(cwd = process.cwd()): ChatMessages[] | null {
  const dir = path.join(cwd, "test");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("run_") && f.endsWith(".json")).sort();
    if (files.length === 0) return null;
    const record = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf-8"));
    return Array.isArray(record.transcript) && record.transcript.length > 0 ? record.transcript : null;
  } catch {
    return null;
  }
}
