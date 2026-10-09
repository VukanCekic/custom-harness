/**
 * Transport for the "local" backend: any server that speaks OpenAI's
 * /chat/completions with SSE streaming (LM Studio, llama-server, Ollama).
 *
 * The transcript stays in the OpenRouter SDK's camelCase shape - sessions and
 * --resume depend on it. This file translates at the wire only: messages out
 * (snake_case), chunks back in (camelCase, the shape callLLM reads).
 *
 * What a real server sends is recorded in tests/fixtures/ (LM Studio + Qwen3-8B):
 * thinking in delta.reasoning_content, tool-call name once then argument
 * fragments, usage in a last chunk whose `choices` is empty, no cost.
 */
import type { ChatMessages, ChatFunctionTool, ChatUsage } from "@openrouter/sdk/models";

// ------------------------------------------------------------------ chunks

export interface StreamChunk {
  error?: { code: number | string; message: string };
  choices: Array<{
    finishReason: string | null;
    delta: {
      content?: string;
      reasoning?: string;
      /** Never set here; the OpenRouter SDK path fills it in. */
      reasoningDetails?: unknown[];
      toolCalls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: ChatUsage;
}

/** One parsed SSE `data:` payload, wire shape (snake_case) -> the shape callLLM reads. */
export function normaliseChunk(raw: any): StreamChunk {
  const choice = raw?.choices?.[0];
  const delta = choice?.delta ?? {};
  const chunk: StreamChunk = {
    // The usage chunk has `choices: []`; callLLM reads choices[0]?, so empty is fine.
    choices: choice
      ? [
          {
            finishReason: choice.finish_reason ?? null,
            delta: {
              content: delta.content ?? undefined,
              // llama-server and LM Studio: reasoning_content. Some servers: reasoning.
              reasoning: delta.reasoning_content ?? delta.reasoning ?? undefined,
              toolCalls: Array.isArray(delta.tool_calls)
                ? delta.tool_calls.map((call: any) => ({
                    index: call.index,
                    id: call.id,
                    type: call.type,
                    function: { name: call.function?.name, arguments: call.function?.arguments }
                  }))
                : undefined
            }
          }
        ]
      : []
  };

  if (raw?.error) {
    chunk.error = {
      code: raw.error.code ?? raw.error.type ?? "unknown",
      message: String(raw.error.message ?? JSON.stringify(raw.error))
    };
  }

  const usage = raw?.usage;
  if (usage) {
    chunk.usage = {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      // Local servers send neither cost nor (LM Studio) cached tokens: those stay undefined, so the ledger counts 0.
      completionTokensDetails: usage.completion_tokens_details
        ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
        : undefined,
      promptTokensDetails: usage.prompt_tokens_details
        ? { cachedTokens: usage.prompt_tokens_details.cached_tokens }
        : undefined
    } as ChatUsage;
  }
  return chunk;
}

// --------------------------------------------------------------------- SSE

/**
 * Yields each `data:` payload as parsed JSON until `[DONE]` or the end of the
 * body. An event may arrive split across network reads, with LF or CRLF line
 * ends; lines starting with ":" are comments (keep-alives) and are skipped.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  const event = (): any | undefined => {
    if (data.length === 0) return undefined;
    const payload = data.join("\n");
    data = [];
    if (payload.trim() === "[DONE]") return DONE;
    try {
      return JSON.parse(payload);
    } catch {
      throw new Error(`Unreadable event from the server: ${payload.slice(0, 200)}`);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          const parsed = event();
          if (parsed === DONE) return;
          if (parsed !== undefined) yield parsed;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } // ":" comments and other fields (event:, id:, retry:) carry nothing we use
      }
      if (done) break;
    }
    // A body that ends without a final blank line still delivers its last event.
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    const parsed = event();
    if (parsed !== undefined && parsed !== DONE) yield parsed;
  } finally {
    reader.cancel().catch(() => {}); // free the connection if the caller stopped early
  }
}

const DONE = Symbol("done");

// ---------------------------------------------------------------- messages

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("");
};

/**
 * Internal (camelCase) transcript -> OpenAI wire messages. Thinking blocks and
 * cache markers are OpenRouter's; a local server has no use for either.
 */
export function toWireMessages(messages: ChatMessages[]): Array<Record<string, unknown>> {
  return messages.map((message: any) => {
    switch (message.role) {
      case "assistant": {
        const calls = message.toolCalls ?? [];
        return {
          role: "assistant",
          // "" rather than null: chat templates concatenate this field.
          content: text(message.content),
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((call: any) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.function.name, arguments: call.function.arguments }
                }))
              }
            : {})
        };
      }
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: text(message.content) };
      default:
        return { role: message.role, content: text(message.content) };
    }
  });
}

// ----------------------------------------------------------------- request

export interface LocalRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessages[];
  tools?: ChatFunctionTool[];
  toolChoice?: "auto" | "required" | "none";
  maxTokens?: number;
}

/** Retry only what is worth retrying, and only before the first byte. A dead local server fails in seconds. */
const RETRY_BUDGET_MS = 15_000;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message ?? parsed?.message ?? body).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

/** POST /chat/completions with streaming; resolves once the server has started answering. */
export async function openaiStream(request: LocalRequest, signal: AbortSignal): Promise<AsyncGenerator<StreamChunk>> {
  const body = {
    model: request.model,
    messages: toWireMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    // Ollama ignores tool_choice, LM Studio and llama-server honour it.
    ...(request.toolChoice && request.tools?.length ? { tool_choice: request.toolChoice } : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {})
  };
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal
  };

  const url = `${request.baseUrl}/chat/completions`;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const wait = Math.min(1_000 * 2 ** attempt, 8_000);
    const outOfTime = Date.now() - started + wait > RETRY_BUDGET_MS;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err: any) {
      if (signal.aborted) throw signal.reason ?? err;
      if (outOfTime) {
        throw new Error(`Could not reach ${request.baseUrl} (${err?.cause?.code ?? err?.message ?? err}). Is the model server running?`);
      }
      await sleep(wait, signal);
      continue;
    }
    if (response.ok && response.body) {
      return (async function* () {
        for await (const raw of parseSSE(response.body!)) yield normaliseChunk(raw);
      })();
    }
    if (response.ok) throw new Error("The server answered without a body.");
    if (RETRYABLE.has(response.status) && !outOfTime) {
      await response.body?.cancel().catch(() => {});
      await sleep(wait, signal);
      continue;
    }
    throw new Error(`${request.baseUrl} answered HTTP ${response.status}: ${await errorMessage(response)}`);
  }
}

// --------------------------------------------------------------- preflight

/**
 * Is the server up, and does it know `model`? Called once at startup so a
 * stopped LM Studio server says so, instead of failing inside the first turn.
 */
export async function checkServer(
  baseUrl: string,
  model: string,
  apiKey = "",
  timeoutMs = 4_000
): Promise<{ ok: true; models: string[] } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return {
      ok: false,
      message: `Could not reach ${baseUrl}. Start the server (LM Studio: Developer tab, Status: Running) or set LOCAL_BASE_URL.`
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: `${baseUrl} rejected the key (HTTP ${response.status}). Set LOCAL_API_KEY.` };
  }
  if (!response.ok) return { ok: false, message: `${baseUrl}/models answered HTTP ${response.status}.` };

  const json: any = await response.json().catch(() => null);
  const models: string[] = Array.isArray(json?.data) ? json.data.map((m: any) => String(m.id)) : [];
  // Ollama and llama-server may list nothing useful; only complain when a list is given and the model is absent.
  if (models.length > 0 && !models.includes(model)) {
    return { ok: false, message: `${baseUrl} has no model "${model}". Set LOCAL_MODEL to one of: ${models.join(", ")}` };
  }
  return { ok: true, models };
}
