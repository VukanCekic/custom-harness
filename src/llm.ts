import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatMessages,
  ChatFunctionTool,
  ChatUsage,
  ChatToolCall
} from "@openrouter/sdk/models";
import { config } from "./config.js";
import { locked } from "./history.js";
import { CancelledError, current, type Role } from "./scope.js";

const openrouter = new OpenRouter({
  apiKey: config.apiKey
});

// The SDK default retries 5XX only - for up to an hour, with no request
// timeout - and never retries 429. Bounded, and rate limits included; the SDK
// honours Retry-After on its own.
const RETRY_BUDGET_MS = 180_000;
const RETRY = {
  retries: {
    strategy: "backoff" as const,
    backoff: { initialInterval: 1_000, maxInterval: 30_000, exponent: 2, maxElapsedTime: RETRY_BUDGET_MS },
    retryConnectionErrors: true
  },
  retryCodes: ["429", "5XX"]
};

// No data for this long means the stream is dead, not slow. Passing our own
// signal switches off the SDK's per-attempt timeout, so this is the only one.
const STALL_MS = Number(process.env.STALL_MS) || 90_000;

export interface Spend {
  calls: number;
  cost: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

const empty = (): Spend => ({ calls: 0, cost: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });

export type Ledger = Spend & { byRole: Partial<Record<Role, Spend>> };

/**
 * Every call this process made - main loop, subagents and compaction alike -
 * in total and per role, so a run record can say where the money went.
 */
export const ledger: Ledger = { ...empty(), byRole: {} };

/** A copy of the ledger, to diff against later. */
export function tally(): Ledger {
  return {
    ...ledger,
    byRole: Object.fromEntries(Object.entries(ledger.byRole).map(([role, spend]) => [role, { ...spend }]))
  };
}

/** What each role spent since `before`. Roles that made no call are left out. */
export function spentSince(before: Ledger): Partial<Record<Role, Spend>> {
  const out: Partial<Record<Role, Spend>> = {};
  for (const [role, now] of Object.entries(ledger.byRole) as Array<[Role, Spend]>) {
    const then = before.byRole[role] ?? empty();
    if (now.calls === then.calls) continue;
    out[role] = {
      calls: now.calls - then.calls,
      cost: now.cost - then.cost,
      promptTokens: now.promptTokens - then.promptTokens,
      cachedTokens: now.cachedTokens - then.cachedTokens,
      completionTokens: now.completionTokens - then.completionTokens
    };
  }
  return out;
}

function record(role: Role, usage: DetailedUsage | null): void {
  const spend = (ledger.byRole[role] ??= empty());
  for (const target of [ledger, spend]) {
    target.calls++;
    target.cost += usage?.cost ?? 0;
    target.promptTokens += usage?.prompt_tokens ?? 0;
    target.cachedTokens += usage?.cached_tokens ?? 0;
    target.completionTokens += usage?.completion_tokens ?? 0;
  }
}

export interface TimingMetrics {
  generation_tokens_per_second: number | null;
  e2e_tokens_per_second: number | null;
  time_to_first_token_ms: number | null;
  generation_time_ms: number | null;
  total_time_ms: number;
}

export interface DetailedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  cost: number | null;
  throughput?: TimingMetrics;
  cost_details?: {
    server_tool_cost?: number | null;
    upstream_inference_cost?: number | null;
    prompt_cost?: number;
    completion_cost?: number;
  } | null;
  raw?: ChatUsage;
}

export function extractUsage(
  usage?: ChatUsage,
  timing?: TimingMetrics
): DetailedUsage | null {
  if (!usage) return null;

  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    reasoning_tokens: usage.completionTokensDetails?.reasoningTokens ?? null,
    cached_tokens: usage.promptTokensDetails?.cachedTokens ?? null,
    cache_write_tokens: usage.promptTokensDetails?.cacheWriteTokens ?? null,
    cost: usage.cost ?? null,
    throughput: timing,
    cost_details: usage.costDetails
      ? {
          server_tool_cost: usage.costDetails.serverToolCost,
          upstream_inference_cost: usage.costDetails.upstreamInferenceCost,
          prompt_cost: usage.costDetails.upstreamInferencePromptCost,
          completion_cost: usage.costDetails.upstreamInferenceCompletionsCost
        }
      : null,
    raw: usage
  };
}

export interface AssistantMessageResult {
  role: "assistant";
  content: string | null;
  toolCalls?: ChatToolCall[];
  /** Thinking blocks some providers need sent back while a tool loop runs. */
  reasoningDetails?: any[];
}

export interface CallLLMResult {
  message: AssistantMessageResult;
  usage: DetailedUsage | null;
  metrics: TimingMetrics;
}

export interface CallOptions {
  onChunk?: (chunk: string) => void;
  /** Defaults to the current scope's signal: Ctrl+C, or a subagent's time limit. */
  signal?: AbortSignal;
  /** Who pays, for the ledger. Defaults to the current scope's role. */
  role?: Role;
  /**
   * How many leading messages are the same from request to request. What
   * follows (the late reminder) changes every call and must not be cached.
   */
  stable?: number;
}

const EPHEMERAL = { type: "ephemeral" as const };

/** Anthropic caches only up to an explicit breakpoint; other providers cache on their own. */
export function usesBreakpoints(model = config.model): boolean {
  return model.startsWith("anthropic/");
}

function marked(message: ChatMessages): ChatMessages {
  const content = (message as any).content;
  if (typeof content !== "string" || !content) return message;
  return { ...message, content: [{ type: "text", text: content, cacheControl: EPHEMERAL }] } as ChatMessages;
}

/**
 * Up to four breakpoints, which is all Anthropic allows: the tool schemas,
 * the system prompt, the end of the locked prefix (system + handoff note),
 * and the newest stable message - the one that lets each step reuse the last.
 * Works on copies; the transcript itself stays plain strings.
 */
export function withBreakpoints(
  messages: ChatMessages[],
  tools: ChatFunctionTool[] | null | undefined,
  stable = messages.length
): { messages: ChatMessages[]; tools: ChatFunctionTool[] | undefined } {
  const out = [...messages];
  const marks = new Set<number>();
  if (out[0]?.role === "system") marks.add(0);
  const lock = locked(out) - 1;
  if (lock > 0) marks.add(lock);
  for (let index = Math.min(stable, out.length) - 1; index > 0; index--) {
    const role = out[index].role;
    if (role === "user" || role === "tool") {
      marks.add(index);
      break;
    }
    if (role === "assistant") break; // its content cannot carry a breakpoint here
  }
  for (const index of marks) out[index] = marked(out[index]);

  const schemas =
    tools && tools.length > 0
      ? tools.map((tool, i) => (i === tools.length - 1 ? ({ ...tool, cacheControl: EPHEMERAL } as ChatFunctionTool) : tool))
      : undefined;
  return { messages: out, tools: schemas };
}

/**
 * Stream chunks carry reasoning details in pieces, keyed by index. Join the
 * text of each piece and keep the last signature, id and format seen.
 */
export function mergeReasoning(into: Map<number, any>, details: any[] | undefined): void {
  for (const [position, detail] of (details ?? []).entries()) {
    if (!detail || typeof detail !== "object") continue;
    const key = typeof detail.index === "number" ? detail.index : position;
    const existing = into.get(key);
    if (!existing) {
      into.set(key, { ...detail });
      continue;
    }
    for (const field of ["text", "summary", "data"]) {
      if (typeof detail[field] === "string") existing[field] = (existing[field] ?? "") + detail[field];
    }
    for (const field of ["signature", "id", "format", "type"]) {
      if (detail[field] != null) existing[field] = detail[field];
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CancelledError();
}

/**
 * Call the LLM with streaming to measure Time-to-First-Token (TTFT),
 * pure model generation speed, end-to-end throughput, and support tool calls.
 *
 * The third argument used to be the chunk callback alone; a bare function is
 * still accepted.
 */
export async function callLLM(
  messages: ChatMessages[],
  tools?: ChatFunctionTool[] | null,
  options: CallOptions | ((chunk: string) => void) = {}
): Promise<CallLLMResult> {
  const opts: CallOptions = typeof options === "function" ? { onChunk: options } : options;
  const onChunk = opts.onChunk;
  const scope = current();
  const signal = opts.signal ?? scope.signal;
  const role = opts.role ?? scope.role;
  if (signal?.aborted) throw abortReason(signal);

  const requestStartTime = performance.now();
  let firstTokenTime: number | null = null;
  let lastTokenTime: number | null = null;
  let fullContent = "";
  let rawUsage: ChatUsage | undefined;
  let finishReason: string | null = null;
  const accumulatedToolCalls: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map();
  const reasoning = new Map<number, any>();

  const watchdog = new AbortController();
  let stall: NodeJS.Timeout | undefined;
  const arm = (ms: number) => {
    clearTimeout(stall);
    stall = setTimeout(() => watchdog.abort(new Error(`no data from the provider for ${ms}ms`)), ms);
    stall.unref();
  };
  arm(RETRY_BUDGET_MS + STALL_MS); // connecting, retries included
  // The SDK retries a TimeoutError as if the network had dropped, so a
  // subagent's deadline (AbortSignal.timeout) used to buy it minutes of
  // retries instead of stopping it. Whatever aborts us, the SDK sees a plain
  // Error, which it gives up on at once; the real reason is rethrown below.
  const stop = new AbortController();
  const sources = signal ? [watchdog.signal, signal] : [watchdog.signal];
  const onAbort = () => stop.abort(new Error("request aborted"));
  for (const source of sources) {
    if (source.aborted) onAbort();
    else source.addEventListener("abort", onAbort, { once: true });
  }
  const abort = stop.signal;

  const request = usesBreakpoints()
    ? withBreakpoints(messages, tools, opts.stable)
    : { messages, tools: tools ?? undefined };

  try {
    const stream = await openrouter.chat.send(
      {
        chatRequest: {
          model: config.model,
          messages: request.messages,
          tools: request.tools,
          stream: true,
          provider: config.provider
        }
      },
      { ...RETRY, signal: abort }
    );

    if (!(Symbol.asyncIterator in stream)) {
      throw new Error("Expected a stream response from OpenRouter.");
    }

    for await (const chunk of stream) {
      arm(STALL_MS);

      // A provider that dies mid-answer says so in-band. Ignoring it handed a
      // half-written answer back as if it were complete.
      if (chunk.error) {
        throw new Error(`Provider error mid-stream (${chunk.error.code}): ${chunk.error.message}`);
      }
      finishReason = chunk.choices[0]?.finishReason ?? finishReason;

      const delta = chunk.choices[0]?.delta;
      const hasToken = Boolean(
        delta?.content || delta?.reasoning || (delta?.toolCalls && delta.toolCalls.length > 0)
      );

      if (hasToken) {
        const now = performance.now();
        if (firstTokenTime === null) {
          firstTokenTime = now;
        }
        lastTokenTime = now;
      }

      if (delta?.reasoningDetails && config.reasoningRoundTrip) {
        mergeReasoning(reasoning, delta.reasoningDetails as any[]);
      }

      if (delta?.content) {
        fullContent += delta.content;
        if (onChunk) {
          onChunk(delta.content);
        }
      }

      if (delta?.toolCalls) {
        for (const tc of delta.toolCalls) {
          const index = tc.index ?? 0;
          const existing = accumulatedToolCalls.get(index) || {
            id: "",
            name: "",
            arguments: ""
          };
          if (tc.id) existing.id = tc.id;
          // Some upstreams resend the whole name in every delta ("bashbashbash").
          if (tc.function?.name && tc.function.name !== existing.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          accumulatedToolCalls.set(index, existing);
        }
      }

      if (chunk.usage) {
        rawUsage = chunk.usage;
      }
    }
  } catch (err) {
    // The SDK reports every abort alike; say which one it was.
    if (signal?.aborted) throw abortReason(signal);
    if (watchdog.signal.aborted) throw abortReason(watchdog.signal);
    throw err;
  } finally {
    clearTimeout(stall);
    for (const source of sources) source.removeEventListener("abort", onAbort);
  }

  if (finishReason === "error") {
    throw new Error("The provider ended the stream with finish_reason=error.");
  }

  const streamEndTime = performance.now();

  const ttftMs =
    firstTokenTime !== null
      ? Math.round(firstTokenTime - requestStartTime)
      : null;

  // Pure generation duration: between first token chunk and last token chunk
  const generationTimeMs =
    firstTokenTime !== null && lastTokenTime !== null
      ? Math.max(1, Math.round(lastTokenTime - firstTokenTime))
      : null;

  const totalTimeMs = Math.round(streamEndTime - requestStartTime);

  const completionTokens = rawUsage?.completionTokens ?? null;

  // Pure model generation throughput (excludes TTFT and network connection overhead)
  const generationTokensPerSecond =
    completionTokens !== null && generationTimeMs !== null && generationTimeMs > 0
      ? Number(((completionTokens / (generationTimeMs / 1000))).toFixed(2))
      : null;

  // End-to-end throughput (includes TTFT, network latency, and generation)
  const e2eTokensPerSecond =
    completionTokens !== null && totalTimeMs > 0
      ? Number(((completionTokens / (totalTimeMs / 1000))).toFixed(2))
      : null;

  const metrics: TimingMetrics = {
    generation_tokens_per_second: generationTokensPerSecond,
    e2e_tokens_per_second: e2eTokensPerSecond,
    time_to_first_token_ms: ttftMs,
    generation_time_ms: generationTimeMs,
    total_time_ms: totalTimeMs
  };

  const toolCalls: ChatToolCall[] | undefined =
    accumulatedToolCalls.size > 0
      ? Array.from(accumulatedToolCalls.values()).map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments
          }
        }))
      : undefined;

  const usage = extractUsage(rawUsage, metrics);
  record(role, usage);

  return {
    message: {
      role: "assistant",
      content: fullContent || null,
      toolCalls,
      reasoningDetails:
        reasoning.size > 0
          ? [...reasoning.entries()].sort((a, b) => a[0] - b[0]).map(([, detail]) => detail)
          : undefined
    },
    usage,
    metrics
  };
}
