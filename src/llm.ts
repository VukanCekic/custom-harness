import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatMessages,
  ChatFunctionTool,
  ChatUsage,
  ChatToolCall
} from "@openrouter/sdk/models";
import { config } from "./config.js";

const openrouter = new OpenRouter({
  apiKey: config.apiKey
});

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
}

export interface CallLLMResult {
  message: AssistantMessageResult;
  usage: DetailedUsage | null;
  metrics: TimingMetrics;
}

/**
 * Call the LLM with streaming to measure Time-to-First-Token (TTFT),
 * pure model generation speed, end-to-end throughput, and support tool calls.
 */
export async function callLLM(
  messages: ChatMessages[],
  tools?: ChatFunctionTool[] | null,
  onChunk?: (chunk: string) => void
): Promise<CallLLMResult> {
  const requestStartTime = performance.now();
  let firstTokenTime: number | null = null;
  let lastTokenTime: number | null = null;
  let fullContent = "";
  let rawUsage: ChatUsage | undefined;
  const accumulatedToolCalls: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map();

  const stream = await openrouter.chat.send({
    chatRequest: {
      model: config.model,
      messages,
      tools: tools ?? undefined,
      stream: true,
      provider: config.provider
    }
  });

  if (!(Symbol.asyncIterator in stream)) {
    throw new Error("Expected a stream response from OpenRouter.");
  }

  for await (const chunk of stream) {
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
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        accumulatedToolCalls.set(index, existing);
      }
    }

    if (chunk.usage) {
      rawUsage = chunk.usage;
    }
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

  return {
    message: {
      role: "assistant",
      content: fullContent || null,
      toolCalls
    },
    usage,
    metrics
  };
}
