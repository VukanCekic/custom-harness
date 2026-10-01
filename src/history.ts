/**
 * Keeping the transcript small enough to send.
 *
 * Three mechanisms, cheapest first:
 *
 * 1. cap    - a fresh tool result is trimmed and the full text parked in a temp
 *             file the agent can page through. Free: the decision is made once,
 *             when the result is created, so it never edits the prefix.
 * 2. strip  - once a turn is over, its tool results shrink to a stub. The edit
 *             lands at the tail, right before the next user message, so the
 *             cached prefix in front of it survives.
 * 3. drop   - a single request is still too big. Throw tool results away whole,
 *             oldest first, until it fits.
 *
 * Everything here refuses to touch the locked prefix - the frozen
 * system + summary + head that compaction leaves behind. That block has to stay
 * byte-identical to stay cached.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";

export const CAP = config.toolCap || 10_000;
export const STUB = config.toolStub || 300;

export const TRIMMED = "[output trimmed:";
export const STRIPPED = "[output stripped:";
export const DROPPED = "[output dropped:";
export const SUMMARY = "<summary>";

export const SPILLS: string[] = [];

// ------------------------------------------------------------------- 1. cap

/**
 * Park the full output on disk for the rest of this turn.
 */
export function spill(text: string): string {
  const tmpDir = os.tmpdir();
  const fileName = `customharness-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, text, "utf-8");
  SPILLS.push(filePath);
  return filePath;
}

/**
 * Trim a fresh tool result, leaving a pointer to the whole thing.
 */
export function cap(text: string): string {
  const limit = config.toolCap || 10_000;
  if (text.length <= limit) {
    return text;
  }

  try {
    const filePath = spill(text);
    const cut = text.length - limit;
    return (
      text.slice(0, limit) +
      `\n\n${TRIMMED} ${cut} of ${text.length} chars cut. ` +
      `The whole output is at ${filePath} - page through it with ` +
      `head, tail, or read_file. It is deleted when this turn ends.]`
    );
  } catch {
    const cut = text.length - limit;
    return (
      text.slice(0, limit) +
      `\n\n${TRIMMED} ${cut} chars cut and the rest could not be saved.]`
    );
  }
}

/**
 * Delete this turn's temp files. Their paths die with the tool results.
 */
export function sweep(): void {
  for (const filePath of SPILLS) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup error
    }
  }
  SPILLS.length = 0;
}

/**
 * Length of the frozen prefix - everything up to and including the newest
 * summary. Derived rather than remembered, so it stays correct across
 * /compact, /rewind and switching sessions.
 */
export function locked(messages: ChatMessages[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const raw = (messages[index] as any)?.content;
    const content = typeof raw === "string" ? raw : "";
    if (content.includes(SUMMARY)) {
      return index + 1;
    }
  }
  return 0;
}

// ----------------------------------------------------------------- 2. strip

/**
 * Shrink every tool result that is no longer part of the live turn.
 *
 * Called once a turn has finished, so by now "everything unlocked" and
 * "everything the model no longer needs in full" are the same set.
 */
export function strip(messages: ChatMessages[]): number {
  const stubLimit = config.toolStub || 300;
  let shrunk = 0;
  const lockIndex = locked(messages);

  for (let index = lockIndex; index < messages.length; index++) {
    const message = messages[index] as any;
    const raw = message?.content;
    const content = typeof raw === "string" ? raw : "";
    if (message.role !== "tool" || content.includes(STRIPPED) || content.length <= stubLimit) {
      continue;
    }

    message.content =
      content.slice(0, stubLimit) +
      `\n\n${STRIPPED} ${content.length - stubLimit} more chars. ` +
      `Run the command again if you need them.]`;
    shrunk++;
  }

  return shrunk;
}

// ------------------------------------------------------------------ 3. drop

/**
 * Rough token count. Good enough to decide whether to panic.
 */
export function estimate(messages: ChatMessages[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += JSON.stringify(m).length;
  }
  return Math.floor(totalChars / 4);
}

/**
 * Last resort: discard whole tool results, oldest first, until it fits.
 *
 * Returns how many went. Normally zero - cap and strip do the real work.
 */
export function fit(
  messages: ChatMessages[],
  budget: number = config.contextWindow * config.compactAt
): number {
  let dropped = 0;
  const lockIndex = locked(messages);

  for (let index = lockIndex; index < messages.length; index++) {
    if (estimate(messages) <= budget) {
      break;
    }
    const message = messages[index] as any;
    const raw = message?.content;
    const content = typeof raw === "string" ? raw : "";
    if (message.role === "tool" && !content.includes(DROPPED)) {
      message.content = `${DROPPED} dropped to fit the context window.]`;
      dropped++;
    }
  }

  return dropped;
}
