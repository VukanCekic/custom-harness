/**
 * The compaction agent.
 *
 * A second agent with one job: read a transcript that has grown too big and
 * write the handoff note a fresh agent would need to carry on.
 *
 * The result replaces the messages it summarised, so this is the only place in
 * the codebase that throws information away for good. It runs rarely and cuts
 * deep - trimming just enough to fit would put us back over the line next turn,
 * and every trim costs the whole prompt cache.
 *
 * One thing is never summarised: what the user actually typed. Requests are
 * pinned verbatim into the note and carried forward by every later compaction,
 * so a summary of a summary cannot paraphrase a constraint out of existence.
 */

import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import { elide, estimate, live, strip, HANDOFF_OPENING } from "./history.js";
import { callLLM } from "./llm.js";

export const SYSTEM_PROMPT = `You are compacting the transcript of a coding session. The session is out of
context window. Write the handoff note that lets a fresh agent pick the work up
without re-reading anything.

Use these sections, in this order. Skip any that would be empty.

## Goal
What the user asked for. Quote them where the exact wording matters.

## What happened
Decisions taken and the reasoning behind them. Include approaches that were
tried and abandoned, and why - those are the expensive lessons, and an agent
without them will try the same dead end again.

## Files
Every file touched: path, and what changed in it.

## State
What works, what is broken, what was left half-finished.

## Next
The immediate next step.

Rules:
- Be specific. Real paths, function names, error text, exact commands.
- Keep anything the user explicitly asked for, corrected, or rejected.
- Never invent progress. If something was not finished, say it was not.
- No preamble and no sign-off. Start at the first heading.`;

export const HANDOFF = `${HANDOFF_OPENING} out of the context window to
free up room. This is the record of it - treat it as your own memory of the
work so far, not as something the user told you.

The user's requests below are quoted exactly and are carried through every
compaction. Where the notes after them disagree, the requests win.
{requests}

{summary}
</summary>`;

const PIN_EACH = 2_000; // chars kept of one request
const PIN_TOTAL = 6_000; // chars kept across all of them

/**
 * Has the last request grown past the point where we rebuild?
 */
export function needed(
  usage?: { prompt_tokens?: number } | null,
  messages?: ChatMessages[],
  overhead = 0
): boolean {
  const threshold = config.contextWindow * config.compactAt;
  if (usage?.prompt_tokens != null && usage.prompt_tokens > 0) {
    return usage.prompt_tokens > threshold;
  }
  if (messages) {
    return estimate(messages) + overhead > threshold;
  }
  return false;
}

function isHandoff(message: ChatMessages): boolean {
  return message.role === "user" && typeof message.content === "string" && message.content.startsWith(HANDOFF_OPENING);
}

/**
 * The user's own words in `messages`, oldest first, including any already
 * pinned by an earlier compaction. Always keeps the first (the original task),
 * then as many of the newest as fit.
 */
export function pinned(messages: ChatMessages[]): string[] {
  const requests: string[] = [];
  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : "";
    if (isHandoff(message)) {
      for (const match of content.matchAll(/<request>\n([\s\S]*?)\n<\/request>/g)) requests.push(match[1]);
    } else if (message.role === "user" && content.trim()) {
      const quoted = content.replaceAll("</request>", "</ request>");
      requests.push(quoted.length > PIN_EACH ? `${quoted.slice(0, PIN_EACH)} [...]` : quoted);
    }
  }
  const unique = requests.filter((r, i) => requests.indexOf(r) === i);
  if (unique.length === 0) return unique;

  const kept = [unique[0]];
  let total = unique[0].length;
  const newest: string[] = [];
  for (let i = unique.length - 1; i > 0 && total + unique[i].length <= PIN_TOTAL; i--) {
    newest.unshift(unique[i]);
    total += unique[i].length;
  }
  return [...kept, ...newest];
}

const ROLES: Record<string, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL RESULT"
};

/**
 * Flatten the transcript into something the summariser can read. An earlier
 * handoff note is labelled as one - rendered as USER it reads as the user
 * speaking, and each generation drifts further from what they actually said.
 */
export function render(messages: ChatMessages[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    let content = typeof message.content === "string" ? message.content : "";
    const toolCalls =
      (message as any).toolCalls || (message as any).tool_calls || [];
    for (const call of toolCalls) {
      const fn = call.function || {};
      const fnName = fn.name || "unknown";
      const fnArgs =
        typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments || {});
      content += `\n[called ${fnName}: ${fnArgs}]`;
    }

    const role = isHandoff(message)
      ? "EARLIER HANDOFF NOTE"
      : ROLES[message.role] || message.role.toUpperCase();
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n\n");
}

/**
 * One LLM call, no tools. Returns the handoff note and what it cost.
 */
export async function summarize(messages: ChatMessages[]): Promise<{ text: string; cost: number }> {
  const response = await callLLM(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: render(messages) }
    ],
    null,
    { role: "compaction" }
  );
  return { text: response.message.content || "", cost: response.usage?.cost ?? 0 };
}

/**
 * First index at or after `start` where cutting cannot orphan a tool call.
 *
 * A tool result has to keep the assistant message that asked for it, so the
 * only safe cut points are the messages that open a fresh exchange.
 */
export function safeBoundary(messages: ChatMessages[], start: number): number {
  for (let index = Math.max(start, 1); index < messages.length; index++) {
    const previous = messages[index - 1] as any;
    const current = messages[index] as any;
    const prevHasToolCalls = Boolean(
      (previous?.toolCalls && previous.toolCalls.length > 0) ||
      (previous?.tool_calls && previous.tool_calls.length > 0)
    );

    if (current.role === "tool" || prevHasToolCalls) {
      continue;
    }
    return index;
  }
  return messages.length;
}

/**
 * Walk back from the end, taking messages until the tail fills `budget`.
 */
export function tailStart(messages: ChatMessages[], budget: number): number {
  let total = 0;
  for (let index = messages.length - 1; index > 0; index--) {
    total += estimate([messages[index]]);
    if (total > budget) {
      return safeBoundary(messages, index);
    }
  }
  return safeBoundary(messages, 1);
}

export interface Compaction {
  before: number;
  after: number;
  cost: number;
  /** The transcript was rewritten. Not the same as after < before: one message can replace one. */
  changed: boolean;
}

/**
 * system + summary + a recent tail, rewritten in place. The caller freezes
 * what comes back.
 *
 * `force` (the /compact command) summarises everything but the newest
 * exchange even when the transcript is still small; otherwise the tail kept
 * verbatim is COMPACT_TO of the window and a short session has nothing old
 * enough to summarise.
 */
export async function compact(messages: ChatMessages[], force = false): Promise<Compaction> {
  const before = messages.length;
  const budget = force ? 0 : config.contextWindow * config.compactTo;
  // Never cut into the exchange the model has not read yet: summarising those
  // results hands it a paraphrase of output it asked for and never saw. If
  // they are too big to keep whole, fit() squeezes them to a pointer instead.
  const fresh = live(messages);
  const unreadFrom = fresh < messages.length ? fresh - 1 : messages.length;
  const cut = Math.min(tailStart(messages, budget), unreadFrom);
  if (cut <= 1) {
    return { before, after: before, cost: 0, changed: false }; // nothing old enough to be worth summarising
  }

  const old = messages.slice(1, cut);
  const { text, cost } = await summarize(old);
  const requests = pinned(old)
    .map((r) => `<request>\n${r}\n</request>`)
    .join("\n");
  // One pass with a replacer function: String.replace expands $$, $& and $'
  // in a replacement *string*, and summaries of shell sessions are full of
  // them; a second pass could also rewrite a "{summary}" the user typed.
  const handoffContent = HANDOFF.replace(/\{(requests|summary)\}/g, (_, key) =>
    key === "requests" ? requests || "(none)" : text
  );

  const kept: ChatMessages[] = [
    messages[0],
    { role: "user", content: handoffContent },
    ...messages.slice(cut)
  ];

  // Shrink the retained tail now, while we are already paying for a rebuilt
  // prefix - but not the newest results, which the model has not read yet.
  strip(kept, true);
  elide(kept, live(kept));

  // In-place update so caller references stay in sync
  messages.splice(0, messages.length, ...kept);
  return { before, after: messages.length, cost, changed: true };
}
