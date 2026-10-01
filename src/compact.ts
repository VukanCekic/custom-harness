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
 */

import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import { estimate, strip } from "./history.js";
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

export const HANDOFF = `<summary>
Everything before this point has been compacted out of the context window to
free up room. This is the record of it - treat it as your own memory of the
work so far, not as something the user told you.

{summary}
</summary>`;

/**
 * Has the last request grown past the point where we rebuild?
 */
export function needed(
  usage?: { prompt_tokens?: number } | null,
  messages?: ChatMessages[]
): boolean {
  const threshold = config.contextWindow * config.compactAt;
  if (usage?.prompt_tokens != null && usage.prompt_tokens > 0) {
    return usage.prompt_tokens > threshold;
  }
  if (messages) {
    return estimate(messages) > threshold;
  }
  return false;
}

const ROLES: Record<string, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL RESULT"
};

/**
 * Flatten the transcript into something the summariser can read.
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

    const role = ROLES[message.role] || message.role.toUpperCase();
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n\n");
}

/**
 * One LLM call, no tools. Returns the handoff note.
 */
export async function summarize(messages: ChatMessages[]): Promise<string> {
  const response = await callLLM(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: render(messages) }
    ],
    null
  );
  return response.message.content || "";
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

/**
 * system + summary + a recent tail. The caller freezes what comes back.
 */
export async function compact(messages: ChatMessages[]): Promise<ChatMessages[]> {
  const budget = config.contextWindow * config.compactTo;
  const cut = tailStart(messages, budget);
  if (cut <= 1) {
    return messages; // nothing old enough to be worth summarising
  }

  const summary = await summarize(messages.slice(1, cut));
  const handoffContent = HANDOFF.replace("{summary}", summary);

  const kept: ChatMessages[] = [
    messages[0],
    { role: "user", content: handoffContent },
    ...messages.slice(cut)
  ];

  // Shrink the retained tail now, while we are already paying for a rebuilt
  // prefix. Stripping is idempotent, so from here the frozen block is final
  // and stays byte-identical - and cached - until the next compaction.
  strip(kept);

  // In-place update so caller references stay in sync
  messages.splice(0, messages.length, ...kept);
  return kept;
}
