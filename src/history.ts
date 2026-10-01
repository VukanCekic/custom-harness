/**
 * Keeping the transcript small enough to send.
 *
 * Three mechanisms, cheapest first:
 *
 * 1. cap    - a fresh tool result is trimmed and the full text parked in a temp
 *             file the agent can page through. Free: the decision is made once,
 *             when the result is created, so it never edits the prefix.
 * 2. strip  - once a turn is over, its tool results shrink to a stub and the
 *             bulky arguments of its tool calls (a whole file passed to
 *             write_file) are elided. The edit lands at the tail, right
 *             before the next user message, so the cached prefix in front of
 *             it survives. Small transcripts are left alone: re-prefilling a
 *             turn costs more than the few tokens a stub saves there.
 * 3. fit    - a single request is still too big. Shrink what the model has
 *             already read - stub it, then drop it, oldest first - and only then
 *             squeeze the newest results down to a pointer at their spill file.
 *             A result the model has not read is never replaced by nothing, and
 *             when the budget is out of reach fit() changes nothing at all.
 *
 * Everything here refuses to touch the locked prefix - the frozen
 * system + summary that compaction leaves behind. That block has to stay
 * byte-identical to stay cached.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";

export const CAP = config.toolCap || 10_000;
export const STUB = config.toolStub || 300;
const SQUEEZE = 1_000; // chars of an unread result kept inline when even that is too much

export const TRIMMED = "[output trimmed:";
export const STRIPPED = "[output stripped:";
export const DROPPED = "[output dropped:";
export const ELIDED = "[content elided:";
export const SUMMARY = "<summary>";

/** Compaction's handoff note always opens with exactly this. */
export const HANDOFF_OPENING = `${SUMMARY}\nEverything before this point has been compacted`;

const DROPPED_NOTE = `${DROPPED} dropped to fit the context window.]`;

const STUB_END = /\n\n\[output stripped: \d+ more chars\. Run the command again if you need them\.\]$/;
const PARKED = /\[output trimmed: \d+ of \d+ chars cut from the middle\. The whole output is at (.+?) - page through it with head, tail, or read_file\./;

const ELIDE_MIN = 500; // chars - an edit argument shorter than this stays verbatim
const ELIDE_ANY = 2_000; // chars - any other string argument longer than this goes

/**
 * Temp files owned by one agent run. Each run sweeps only its own, so a
 * subagent finishing cannot delete a file its parent was told to page through.
 */
export type SpillScope = string[];

/** The main agent's current turn. Subagents bring their own scope. */
export const SPILLS: SpillScope = [];

/** Every spill file still on disk, whichever run owns it. */
const LIVE = new Set<string>();
const spillKey = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * Is this one of the harness's own live spill files? They sit in the OS temp
 * directory, outside the project, so without this every attempt to page one
 * needed an approval - and read-only subagents were refused outright.
 */
export function isSpill(filePath: string): boolean {
  return LIVE.has(spillKey(filePath));
}

function text(message: ChatMessages): string {
  const raw = (message as any)?.content;
  return typeof raw === "string" ? raw : "";
}

/**
 * What a result already is, judged by the exact shape strip() and fit() give
 * it - never by a marker appearing somewhere inside. A result that merely
 * quotes a marker (reading this file does) used to count as stripped forever,
 * and fit() priced it as droppable while refusing to drop it.
 */
const isStub = (content: string) => STUB_END.test(content);
const isDropped = (content: string) => content === DROPPED_NOTE;

// ------------------------------------------------------------------- 1. cap

/**
 * Park the full output on disk for the rest of this turn.
 */
export function spill(text: string, scope: SpillScope = SPILLS): string {
  const fileName = `customharness-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const filePath = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(filePath, text, "utf-8");
  scope.push(filePath);
  LIVE.add(spillKey(filePath));
  return filePath;
}

/** Move a cut point off the middle of a surrogate pair. */
function boundary(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/**
 * Trim a fresh tool result, leaving a pointer to the whole thing.
 *
 * Keeps the head and the tail: compilers and test runners print the verdict
 * last, so a head-only cut hides exactly the line the agent needs.
 */
export function cap(
  text: string,
  scope: SpillScope = SPILLS,
  limit: number = config.toolCap || 10_000,
  parked?: string
): string {
  if (text.length <= limit) {
    return text;
  }

  const headEnd = boundary(text, Math.floor(limit * 0.7));
  const tailStart = boundary(text, text.length - (limit - headEnd));
  let pointer: string;
  try {
    const filePath = parked ?? spill(text, scope);
    pointer =
      `The whole output is at ${filePath} - page through it with ` +
      `head, tail, or read_file. It is deleted when this turn ends.`;
  } catch {
    pointer = "The rest could not be saved.";
  }
  return (
    text.slice(0, headEnd) +
    `\n\n${TRIMMED} ${tailStart - headEnd} of ${text.length} chars cut from the middle. ${pointer}]\n\n` +
    text.slice(tailStart)
  );
}

/**
 * Delete one run's temp files. Their paths die with the tool results.
 */
export function sweep(scope: SpillScope = SPILLS): void {
  for (const filePath of scope) {
    LIVE.delete(spillKey(filePath));
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Ignore cleanup error
    }
  }
  scope.length = 0;
}

/**
 * Length of the frozen prefix - everything up to and including the newest
 * summary. Derived rather than remembered, so it stays correct across
 * /compact and --resume.
 *
 * Only compaction's own note counts. A C# doc comment or an HTML <details>
 * block in a tool result contains "<summary>" too, and treating that as the
 * lock froze every tool result in front of it at full size.
 */
export function locked(messages: ChatMessages[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user" && text(messages[index]).startsWith(HANDOFF_OPENING)) {
      return index + 1;
    }
  }
  return 0;
}

/**
 * Where the newest step's tool results begin. The model has not read these
 * yet: replace one with a marker and it re-runs the command, the new result
 * is dropped too, and the turn never converges.
 */
export function live(messages: ChatMessages[]): number {
  let index = messages.length;
  while (index > 0 && messages[index - 1].role === "tool") {
    index--;
  }
  return index;
}

// ----------------------------------------------------------------- 2. strip

function stub(content: string): string {
  const stubLimit = config.toolStub || 300;
  return (
    content.slice(0, stubLimit) +
    `\n\n${STRIPPED} ${content.length - stubLimit} more chars. ` +
    `Run the command again if you need them.]`
  );
}

/**
 * Shrink every tool result that is no longer part of the live turn.
 *
 * Called once a turn has finished, so by now "everything unlocked" and
 * "everything the model no longer needs in full" are the same set. Mid-turn
 * callers pass protectLive so the results the model is about to read survive.
 */
export function strip(messages: ChatMessages[], protectLive = false): number {
  const stubLimit = config.toolStub || 300;
  const end = protectLive ? live(messages) : messages.length;
  let shrunk = 0;

  for (let index = locked(messages); index < end; index++) {
    const message = messages[index] as any;
    const content = text(message);
    if (message.role !== "tool" || isStub(content) || isDropped(content) || content.length <= stubLimit) {
      continue;
    }
    message.content = stub(content);
    shrunk++;
  }

  return shrunk;
}

/**
 * The same call with its bulky string arguments replaced by a note, or null
 * when there is nothing worth eliding. Arguments that are not valid JSON are
 * left exactly as they are.
 */
function elided(call: any): any | null {
  let args: Record<string, any>;
  try {
    args = JSON.parse(call?.function?.arguments || "{}");
  } catch {
    return null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;

  const name = call.function.name;
  const edit = name === "write_file" || name === "str_replace" || name === "string_replace";
  let changed = false;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || value.startsWith(ELIDED)) continue;
    if (value.length <= (edit ? ELIDE_MIN : ELIDE_ANY)) continue;
    args[key] =
      name === "write_file" && key === "content"
        ? `${ELIDED} ${value.length} chars written to ${args.path ?? "the file"}. Read the file to see it.]`
        : `${ELIDED} ${value.length} chars.]`;
    changed = true;
  }
  return changed ? { ...call, function: { ...call.function, arguments: JSON.stringify(args) } } : null;
}

/** An assistant message with its finished tool calls slimmed down, or null if nothing changes. */
function slimmed(message: ChatMessages): ChatMessages | null {
  const m = message as any;
  if (m.role !== "assistant") return null;
  let changed = false;
  const toolCalls = (m.toolCalls ?? []).map((call: any) => {
    const next = elided(call);
    if (next) changed = true;
    return next ?? call;
  });
  // Thinking blocks are only needed while their own tool loop runs.
  if (m.reasoningDetails) changed = true;
  if (!changed) return null;
  const { reasoningDetails: _, ...rest } = m;
  return (toolCalls.length > 0 ? { ...rest, toolCalls } : rest) as ChatMessages;
}

/**
 * Elide the bulky arguments of finished tool calls. Like strip(), this is
 * meant for the turn boundary; the call already ran, and its result says
 * what happened.
 */
export function elide(messages: ChatMessages[], end = messages.length): number {
  let count = 0;
  for (let index = locked(messages); index < end; index++) {
    const next = slimmed(messages[index]);
    if (next) {
      messages[index] = next;
      count++;
    }
  }
  return count;
}

/**
 * End of turn: strip and elide - but only once the transcript is big enough
 * for it to pay. Each strip costs one re-prefill of the previous turn
 * (35 % of the prefix reused at the boundary, measured), which below
 * STRIP_AFTER of the window is more than the stubs save.
 */
export function settle(messages: ChatMessages[], overhead = 0): number {
  if (estimate(messages) + overhead < config.contextWindow * config.stripAfter) {
    return 0;
  }
  return strip(messages) + elide(messages);
}

// ------------------------------------------------------------------ 3. fit

/**
 * Rough token count. Calibrated against 37 recorded runs: provider-reported
 * prompt_tokens ~= 0.99 x this + the fixed overhead it does not see (tool
 * schemas, reminder) - so callers must add that overhead themselves.
 */
export function estimate(messages: ChatMessages[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += JSON.stringify(m).length;
  }
  return Math.floor(totalChars / 4);
}

/** Re-cap an unread result to SQUEEZE chars, reusing its spill file if it has one. */
function squeeze(content: string, scope: SpillScope): string {
  // Only a pointer cap() itself wrote, to a file it still owns - not a path
  // that happens to appear in the output.
  const parked = content.match(PARKED)?.[1];
  if (parked && isSpill(parked) && fs.existsSync(parked)) {
    return cap(fs.readFileSync(parked, "utf-8"), scope, SQUEEZE, parked);
  }
  return cap(content, scope, SQUEEZE);
}

/** What squeeze() would leave of a message, priced without writing a file. */
function squeezedSize(message: ChatMessages): number {
  const content = text(message);
  const head = Math.floor(SQUEEZE * 0.7);
  const pointer =
    `\n\n${TRIMMED} ${content.length} of ${content.length} chars cut from the middle. The whole output is at ` +
    `${path.join(os.tmpdir(), "customharness-tool-0000000000000-000000.txt")} - page through it with ` +
    "head, tail, or read_file. It is deleted when this turn ends.]\n\n";
  const kept = content.slice(0, head) + pointer + content.slice(content.length - (SQUEEZE - head));
  return estimate([{ ...(message as any), content: kept } as ChatMessages]);
}

export interface Fit {
  tokens: number; // estimated request size afterwards, overhead included
  floor: number; // the smallest fit() could have made it
  fits: boolean;
  stubbed: number;
  elided: number;
  dropped: number;
  squeezed: number;
}

/**
 * Last resort: shrink tool results until the request fits.
 *
 * Prices the deepest possible cut before making any, and works on a copy
 * that is committed only if it fits. Either the request fits afterwards or
 * the transcript is exactly as it was: throwing results away on the way to
 * failing anyway is how past runs went blind. When it cannot fit, the caller
 * has to compact or stop. Normally a no-op: cap, strip and compaction do the
 * real work.
 */
export function fit(
  messages: ChatMessages[],
  budget: number = config.contextWindow * config.compactAt,
  overhead = 0,
  scope: SpillScope = SPILLS
): Fit {
  const sizes = messages.map((m) => estimate([m]));
  const total = overhead + sizes.reduce((sum, n) => sum + n, 0);
  let tokens = total;
  const result: Fit = { tokens, floor: tokens, fits: tokens <= budget, stubbed: 0, elided: 0, dropped: 0, squeezed: 0 };
  if (result.fits) {
    return result;
  }

  const fresh = live(messages);
  const read: number[] = [];
  const unread: number[] = [];
  // Tool-call arguments used to be irreducible: one 200k-char write_file
  // could put a request out of reach for good. The call whose results are
  // still unread keeps its reasoning: its tool loop is not over.
  const slim = new Map<number, ChatMessages>();
  for (let index = locked(messages); index < messages.length; index++) {
    if (messages[index].role === "tool") {
      (index < fresh ? read : unread).push(index);
    }
    const next = index === fresh - 1 && fresh < messages.length ? null : slimmed(messages[index]);
    if (next) slim.set(index, next);
  }
  const squeezable = (index: number) => text(messages[index]).length > SQUEEZE + 400;

  // The deepest cut, priced by the same rules the passes below follow.
  const droppedSize = estimate([{ role: "tool", toolCallId: "", content: DROPPED_NOTE } as ChatMessages]);
  result.floor =
    total -
    [...slim].reduce((sum, [i, next]) => sum + Math.max(0, sizes[i] - estimate([next])), 0) -
    read.reduce((sum, i) => sum + (isDropped(text(messages[i])) ? 0 : Math.max(0, sizes[i] - droppedSize)), 0) -
    unread.filter(squeezable).reduce((sum, i) => sum + Math.max(0, sizes[i] - squeezedSize(messages[i])), 0);
  if (result.floor > budget) {
    return result;
  }

  // Entries of the copy are replaced, never edited, so the original is
  // untouched until the commit below.
  const work = [...messages];
  const replace = (index: number, next: ChatMessages) => {
    work[index] = next;
    const size = estimate([next]);
    tokens += size - sizes[index];
    sizes[index] = size;
  };
  const withContent = (index: number, content: string) => ({ ...(work[index] as any), content }) as ChatMessages;
  const done = { stubbed: 0, elided: 0, dropped: 0, squeezed: 0 };

  // 1. stub what the model has already read, oldest first
  for (const index of read) {
    if (tokens <= budget) break;
    const content = text(work[index]);
    if (isStub(content) || isDropped(content) || content.length <= STUB) continue;
    replace(index, withContent(index, stub(content)));
    done.stubbed++;
  }

  // 2. elide the arguments of calls that already ran, oldest first
  for (const [index, next] of slim) {
    if (tokens <= budget) break;
    replace(index, next);
    done.elided++;
  }

  // 3. then drop what the model has read, oldest first
  for (const index of read) {
    if (tokens <= budget) break;
    if (isDropped(text(work[index]))) continue;
    replace(index, withContent(index, DROPPED_NOTE));
    done.dropped++;
  }

  // 4. only then squeeze what it has not read, biggest first - never to
  //    nothing: the full text stays on disk and the pointer says where
  for (const index of [...unread].sort((a, b) => sizes[b] - sizes[a])) {
    if (tokens <= budget) break;
    if (!squeezable(index)) continue;
    replace(index, withContent(index, squeeze(text(work[index]), scope)));
    done.squeezed++;
  }

  if (tokens > budget) {
    // The estimate of the floor was a little optimistic. Report the floor
    // actually reached and leave the transcript alone.
    return { ...result, floor: tokens };
  }
  for (let index = 0; index < work.length; index++) {
    if (work[index] !== messages[index]) messages[index] = work[index];
  }
  return { ...result, ...done, tokens, fits: true };
}
