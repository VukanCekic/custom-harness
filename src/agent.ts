import type { ChatFunctionTool, ChatMessages } from "@openrouter/sdk/models";
import { config, getSystemPrompt, type Mode } from "./config.js";
import {
  callLLM,
  ledger,
  spentSince,
  tally,
  type AssistantMessageResult,
  type DetailedUsage,
  type Spend,
  type TimingMetrics
} from "./llm.js";
import { TOOL_SCHEMAS, toolsFor } from "./tools/index.js";
import { reminder } from "./context.js";
import { cap, sweep, settle, fit, estimate } from "./history.js";
import { compact } from "./compact.js";
import { approver, asker, cutOff, execute, peek, type Asker } from "./execute.js";
import { blame, observe, type CacheBreak } from "./cache.js";
import { CancelledError, within, type Role } from "./scope.js";

export interface AgentOptions {
  messages?: ChatMessages[];
  onStepStart?: (step: number) => void;
  onStepEnd?: (step: number, usage: DetailedUsage | null) => void;
  onToolCall?: (toolName: string, args: Record<string, any>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onToolExecution?: (toolName: string, args: Record<string, any>, result: string) => void;
  onMessage?: (content: string) => void;
  onAssistantMessage?: (message: AssistantMessageResult) => void;
  onInjection?: (content: string) => void;
  onApprove?: (reason: string) => Promise<boolean>;
  /** Answers ask_user. Without it the agent is told no one can answer. */
  onAsk?: Asker;
  onChunk?: (chunk: string) => void;
  onCompacted?: (before: number, messages: ChatMessages[]) => void;
  onNote?: (text: string) => void;
  /**
   * Called after every change to the transcript, so a session log can keep up.
   * `replaced` names a rewrite (compaction) the log must record whole: the
   * message count alone cannot tell, since one message can replace one.
   */
  onTranscript?: (messages: ChatMessages[], replaced?: string) => void;
  onCacheBreak?: (info: CacheBreak) => void;
  onModeChange?: (mode: Mode) => void;
  injectReminder?: boolean;
  maxSteps?: number;
  /** "pipeline" restricts the agent to coordinating subagents. */
  mode?: Mode;
  /** Abort to cancel the turn (Ctrl+C). The transcript is left valid. */
  signal?: AbortSignal;
}

export interface StepRecord {
  step: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cost: number | null;
  ttft_ms: number | null;
  tool_calls: string[];
}

export interface CompactionRecord {
  step: number;
  before: number;
  after: number;
  cost: number;
}

export interface AgentResult {
  finalResponse: string;
  messages: ChatMessages[];
  steps: number;
  totalCost: number;
  lastUsage: DetailedUsage | null;
  lastMetrics: TimingMetrics | null;
  /** Usage of every main-loop request, not just the last. */
  stepUsage: StepRecord[];
  compactions: CompactionRecord[];
  cacheBreaks: Array<CacheBreak & { step: number }>;
  /** Everything this turn paid for, by who paid: main, each subagent role, compaction. */
  costByRole: Partial<Record<Role, Spend>>;
  /** cached / prompt tokens over this turn's main-loop requests, or null without data. */
  cacheHitRate: number | null;
  cancelled: boolean;
  mode: Mode;
}

const REMINDER_RESERVE = 300; // tokens kept free for the late-injected <env>/<todos> block

/**
 * Tokens every request carries that the transcript does not: the tool schemas
 * and the late reminder. The estimator never sees them, which is why fit() and
 * compaction used to disagree about whether a request fitted.
 */
export function overhead(tools: ChatFunctionTool[] = TOOL_SCHEMAS): number {
  return Math.ceil(JSON.stringify(tools).length / 4) + REMINDER_RESERVE;
}

/**
 * Startup check: is there any room left for the conversation at all?
 * Returns a warning, or null when the configuration is sane.
 */
export function budgetWarning(systemPrompt: string = config.systemPrompt): string | null {
  const budget = config.contextWindow * config.compactAt;
  const fixed = overhead() + estimate([{ role: "system", content: systemPrompt }]);
  if (fixed < budget / 2) return null;
  return (
    `CONTEXT_WINDOW=${config.contextWindow} leaves ${Math.max(0, Math.round(budget - fixed))} tokens for the ` +
    `conversation: tool schemas and the system prompt already take ~${fixed} of the ${budget}-token budget. ` +
    `Long tool output and compaction will not have room to work.`
  );
}

export class ContextBudgetError extends Error {
  name = "ContextBudgetError";
}

const CANCELLED = "[cancelled by user before this ran]";

/**
 * Runs the autonomous agent loop.
 * Continues calling the LLM and executing requested tools in a loop
 * until the model finishes without requesting any more tool calls.
 */
export async function runAgent(
  userInput: string,
  options: AgentOptions = {}
): Promise<AgentResult> {
  let mode: Mode = options.mode ?? "default";

  // If an existing conversation history is provided, append user prompt to it;
  // otherwise, initialize a fresh transcript with system prompt.
  const messages: ChatMessages[] = options.messages ?? [
    { role: "system", content: getSystemPrompt(mode) }
  ];
  const persist = () => options.onTranscript?.(messages);

  const lastMsg = messages[messages.length - 1];
  if (userInput && (lastMsg?.role !== "user" || lastMsg?.content !== userInput)) {
    messages.push({ role: "user", content: userInput });
    persist();
  }

  const budget = config.contextWindow * config.compactAt;
  let tools = toolsFor(mode);
  let fixed = overhead(tools.schemas);
  const maxSteps = options.maxSteps ?? config.maxSteps;
  const signal = options.signal;

  // Transcript size right after the last compaction. Until it has grown by a
  // quarter of the window, compacting again would only summarise the summary -
  // the cascade that lost the user's instructions in past runs.
  let compactedAt = -Infinity;

  // Everything this turn paid for, read off the ledger: the main loop's calls,
  // but also compaction and every subagent - which used to go uncounted.
  const spentBefore = tally();

  let step = 0;
  let lastUsage: DetailedUsage | null = null;
  let lastMetrics: TimingMetrics | null = null;
  let finalResponse = "";
  let cancelled = false;
  const stepUsage: StepRecord[] = [];
  const compactions: CompactionRecord[] = [];
  const cacheBreaks: AgentResult["cacheBreaks"] = [];

  const loop = async () => {
    while (true) {
      step++;

      if (step > maxSteps) {
        finalResponse = `(stopped after ${maxSteps} steps without finishing - say "continue" to carry on.)`;
        options.onMessage?.(finalResponse);
        step--;
        break;
      }
      if (signal?.aborted) throw new CancelledError();

      if (options.onStepStart) {
        options.onStepStart(step);
      }

      // 1. Compaction first: it summarises what it removes, fit() only loses it.
      //    Checked before the request, so no call is paid for and then thrown away.
      let compactedNow = false;
      const tryCompact = async () => {
        compactedNow = true;
        const before = messages.length;
        try {
          blame(messages, "compaction");
          const done = await compact(messages);
          if (done.changed) {
            compactions.push({ step, before, after: done.after, cost: done.cost });
            options.onTranscript?.(messages, "compaction");
            options.onCompacted?.(before, messages);
          }
        } catch (err: any) {
          if (signal?.aborted) throw err;
          // One more API call, fired when the window is nearly full - the worst
          // moment to lose the turn over a rate limit. fit() still runs below.
          options.onNote?.(`compaction failed (${err.message || String(err)}); continuing without it`);
        }
        compactedAt = estimate(messages);
      };
      const size = estimate(messages);
      if (size + fixed > budget && size - compactedAt > config.contextWindow * 0.25) {
        await tryCompact();
      }

      // 2. Last resort. It refuses an unreachable target rather than dropping
      //    every result on the way to failing anyway. Before stopping the turn,
      //    one compaction the cooldown held back is still better than none.
      let fitted = fit(messages, budget, fixed);
      const floorOfPrompt = fixed + estimate([messages[0]]);
      if (!fitted.fits && !compactedNow && floorOfPrompt <= budget) {
        await tryCompact();
        fitted = fit(messages, budget, fixed);
      }
      if (fitted.stubbed + fitted.elided + fitted.dropped + fitted.squeezed > 0) {
        blame(messages, "fit");
        options.onNote?.(
          `shrank the transcript to fit: ${fitted.stubbed} stubbed, ${fitted.elided} elided, ` +
          `${fitted.dropped} dropped, ${fitted.squeezed} squeezed`
        );
      }
      if (!fitted.fits) {
        throw new ContextBudgetError(
          floorOfPrompt > budget
            ? `The tool schemas and system prompt alone need ~${floorOfPrompt} tokens, more than the ${Math.round(budget)}-token ` +
              `budget (CONTEXT_WINDOW=${config.contextWindow} x COMPACT_AT=${config.compactAt}). Raise CONTEXT_WINDOW; /compact cannot help.`
            : `This request needs ~${fitted.floor} tokens even with every old tool result dropped, but the budget is ` +
              `${Math.round(budget)} (CONTEXT_WINDOW=${config.contextWindow} x COMPACT_AT=${config.compactAt}; ~${fixed} of it ` +
              `tool schemas and the reminder reserve). Raise CONTEXT_WINDOW or run /compact.`
        );
      }

      // Late injection: a small dynamic block appended just before sending.
      // Appended to the very end of messages passed to callLLM so the stable prefix
      // in messages stays cached by the LLM provider.
      let lateReminder: ChatMessages | null = null;
      if (options.injectReminder !== false) {
        lateReminder = await reminder();
        if (options.onInjection && typeof lateReminder.content === "string") {
          options.onInjection(lateReminder.content);
        }
      }
      const messagesToSend: ChatMessages[] =
        lateReminder ? [...messages, lateReminder] : messages;

      const broke = observe(messages, messages.length, tools.schemas);
      if (broke) {
        cacheBreaks.push({ step, ...broke });
        options.onCacheBreak?.(broke);
      }

      // Call the LLM with conversation history (+ late injection) and available tools
      const { message, usage, metrics, finishReason } = await callLLM(messagesToSend, tools.schemas, {
        onChunk: options.onChunk,
        stable: messages.length
      });
      const truncated = finishReason === "length";

      lastUsage = usage;
      lastMetrics = metrics;
      stepUsage.push({
        step,
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null,
        cached_tokens: usage?.cached_tokens ?? null,
        cost: usage?.cost ?? null,
        ttft_ms: metrics.time_to_first_token_ms,
        tool_calls: (message.toolCalls ?? []).map((c) => c.function.name)
      });

      // Record the assistant's response in history. Reasoning details ride
      // along for providers that need them back during the tool loop; strip
      // drops them once the turn is over.
      messages.push({
        role: "assistant",
        content: message.content || "",
        toolCalls: message.toolCalls,
        ...(message.reasoningDetails ? { reasoningDetails: message.reasoningDetails } : {})
      } as ChatMessages);
      persist();

      if (options.onAssistantMessage) {
        options.onAssistantMessage(message);
      }

      if (message.content) {
        finalResponse = message.content;
        if (options.onMessage) {
          options.onMessage(message.content);
        }
      }

      // If no tool calls were requested, the agent is done
      if (!message.toolCalls || message.toolCalls.length === 0) {
        if (truncated) {
          finalResponse += "\n\n(the answer was cut off: it hit the output-token limit)";
          options.onNote?.("the answer hit the output-token limit and is incomplete - say \"continue\" for the rest");
        }
        if (options.onStepEnd) {
          options.onStepEnd(step, usage);
        }
        break;
      }

      // Execute each tool call through the same gate subagents use. The
      // approver rides along in async context, so a subagent started by one
      // of these calls asks the same human instead of skipping the question.
      const calls = message.toolCalls;
      for (let index = 0; index < calls.length; index++) {
        const toolCall = calls[index];
        const toolName = toolCall.function.name;

        if (signal?.aborted) {
          // Every call needs a result, or the next request is malformed.
          for (const pending of calls.slice(index)) {
            messages.push({ role: "tool", toolCallId: pending.id, content: CANCELLED });
          }
          persist();
          throw new CancelledError();
        }

        if (options.onToolCall) {
          options.onToolCall(toolName, peek(toolCall.function.arguments));
        }

        // In pipeline mode the agent's own bash is read-only: anything that
        // would need approval is refused, so edits go through the worker.
        const approve = mode === "pipeline" && toolName === "bash" ? undefined : options.onApprove;
        const cut = truncated ? cutOff(toolCall) : null;
        const { args, result } = cut
          ? { args: {}, result: cut }
          : await approver.run(options.onApprove, () =>
              asker.run(options.onAsk, () => execute(toolCall, { tools: tools.byName, approve }))
            );

        // Cap fresh tool result: if oversized, spill to disk and replace with pointer
        const cappedResult = cap(result);

        if (options.onToolResult) {
          options.onToolResult(toolName, cappedResult);
        }

        if (options.onToolExecution) {
          options.onToolExecution(toolName, args, cappedResult);
        }

        // Add tool output back into conversation history
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: cappedResult
        });
        persist();

        // The pipeline has started: from here on the agent coordinates and
        // the worker edits. Only for this turn - the next one starts in the
        // mode the session is in.
        if (toolName === "plan_task" && mode === "default") {
          mode = "pipeline";
          tools = toolsFor(mode);
          fixed = overhead(tools.schemas);
          options.onNote?.("pipeline started: until this turn ends the agent coordinates and only the worker edits");
          options.onModeChange?.(mode);
        }
      }

      if (options.onStepEnd) {
        options.onStepEnd(step, usage);
      }
    }
  };

  try {
    await within({ role: "main", signal }, loop);
  } catch (err) {
    // Any abort of the turn's own signal is the user cancelling it.
    if (!(err instanceof CancelledError) && !signal?.aborted) throw err;
    cancelled = true;
    finalResponse = "(cancelled by user)";
  } finally {
    // Once the turn is finished, shrink past tool results to stubs - if the
    // transcript is big enough for that to pay - and clean up temp files.
    if (settle(messages, fixed) > 0) blame(messages, "strip");
    sweep();
    persist();
  }

  const costByRole = spentSince(spentBefore);
  const main = costByRole.main;
  return {
    finalResponse,
    messages,
    steps: step,
    totalCost: ledger.cost - spentBefore.cost,
    lastUsage,
    lastMetrics,
    stepUsage,
    compactions,
    cacheBreaks,
    costByRole,
    cacheHitRate: main && main.promptTokens > 0 ? main.cachedTokens / main.promptTokens : null,
    cancelled,
    mode
  };
}
