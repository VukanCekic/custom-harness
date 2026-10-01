/**
 * Where the prompt cache breaks, and why.
 *
 * A provider can only reuse the part of a request that is byte-identical to
 * the previous one. Each request's messages are hashed one by one; the first
 * index that differs from last time is where re-prefilling starts. Whoever
 * edits the prefix on purpose - strip, compaction, fit, a mode switch - says
 * so with blame(), and the next request reports that reason instead of
 * "unexplained".
 */

import crypto from "node:crypto";
import type { ChatFunctionTool, ChatMessages } from "@openrouter/sdk/models";

export type BreakReason = "strip" | "compaction" | "fit" | "mode" | "rewind";

export interface CacheBreak {
  /** First message index that differs from the previous request. */
  at: number;
  /** How many messages the previous request had. */
  of: number;
  /** Share of the previous request's characters still reusable, 0..1. */
  reused: number;
  reason: string;
}

interface Track {
  hashes: string[];
  sizes: number[];
  tools: string;
  blamed: Set<BreakReason>;
}

const TRACKS = new WeakMap<ChatMessages[], Track>();

const hash = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "";
  return crypto.createHash("sha1").update(text).digest("hex");
};

/** Record that `reason` is about to edit (or just edited) this transcript's prefix. */
export function blame(messages: ChatMessages[], reason: BreakReason): void {
  TRACKS.get(messages)?.blamed.add(reason);
}

/**
 * Compare the stable part of this request - everything but the late
 * reminder - with the previous request for the same transcript. Returns null
 * when the whole previous request is still a prefix, or on the first call.
 */
export function observe(
  messages: ChatMessages[],
  stable: number,
  tools: ChatFunctionTool[] | undefined
): CacheBreak | null {
  const prefix = messages.slice(0, stable);
  const next: Track = {
    hashes: prefix.map(hash),
    sizes: prefix.map((m) => (JSON.stringify(m) ?? "").length),
    tools: hash(tools ?? []),
    blamed: new Set()
  };
  const previous = TRACKS.get(messages);
  TRACKS.set(messages, next);
  if (!previous) return null;

  const toolsChanged = previous.tools !== next.tools;
  let at = 0;
  if (!toolsChanged) {
    while (at < previous.hashes.length && at < next.hashes.length && previous.hashes[at] === next.hashes[at]) at++;
    if (at === previous.hashes.length) return null;
  }

  const total = previous.sizes.reduce((sum, n) => sum + n, 0) || 1;
  const kept = previous.sizes.slice(0, at).reduce((sum, n) => sum + n, 0);
  const reasons = [...previous.blamed];
  return {
    at,
    of: previous.hashes.length,
    reused: kept / total,
    reason: toolsChanged ? "tool set changed" : reasons.length > 0 ? reasons.join(" + ") : "unexplained edit"
  };
}

/** Forget a transcript, e.g. after /clear. */
export function forget(messages: ChatMessages[]): void {
  TRACKS.delete(messages);
}
