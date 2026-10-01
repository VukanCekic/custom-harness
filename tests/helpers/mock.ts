/**
 * Deterministic stand-in for OpenRouter. Replaces globalThis.fetch (which the
 * Speakeasy SDK resolves at call time), records every request body, and answers
 * with scripted SSE chunks that satisfy the SDK's zod schemas.
 */

export interface MockToolCall {
  name: string;
  arguments: string;
  id?: string;
}

export interface MockTurn {
  content?: string;
  toolCalls?: MockToolCall[];
  promptTokens?: number; // default: request body chars / 4 (includes tool schemas, like the real API)
  cachedTokens?: number;
  status?: number; // non-200 -> JSON error response
  errorChunkAfterContent?: boolean; // emit a mid-stream error chunk after the content
  repeatNameInEveryChunk?: boolean; // some upstreams resend function.name in every delta
  omitIndex?: boolean; // some upstreams omit tool_call.index
  reasoningDetails?: any[]; // streamed as reasoning_details, split across two chunks
  delayMs?: number; // wait before answering; honours the request's abort signal
}

export type Script = (body: any, callIndex: number) => MockTurn | Promise<MockTurn>;

export const requests: any[] = [];
export const rawBodies: string[] = [];
let script: Script = () => ({ content: "ok" });

export function setScript(s: Script) {
  script = s;
}

export function reset() {
  requests.length = 0;
  rawBodies.length = 0;
}

export function install() {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const req: Request = input instanceof Request ? input : new Request(input, init);
    const bodyText = await req.text();
    const body = JSON.parse(bodyText);
    requests.push(body);
    rawBodies.push(bodyText);
    const turn = await script(body, requests.length - 1);
    if (turn.delayMs) {
      const signal: AbortSignal | undefined = req.signal;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        const timer = setTimeout(resolve, turn.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    }

    if (turn.status && turn.status !== 200) {
      return new Response(
        JSON.stringify({ error: { code: turn.status, message: `mock ${turn.status}` } }),
        { status: turn.status, headers: { "content-type": "application/json" } }
      );
    }

    const base = { id: "mock", created: 1, model: String(body.model), object: "chat.completion.chunk" };
    const chunks: any[] = [];
    if (turn.content) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.content }, finish_reason: null }] });
    }
    for (const [i, detail] of (turn.reasoningDetails || []).entries()) {
      const text = String(detail.text ?? "");
      const half = Math.floor(text.length / 2);
      chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_details: [{ ...detail, index: i, text: text.slice(0, half) }] }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_details: [{ type: detail.type, index: i, text: text.slice(half) }] }, finish_reason: null }] });
    }
    if (turn.errorChunkAfterContent) {
      chunks.push({ ...base, error: { code: 502, message: "upstream died mid-stream" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] });
    }
    (turn.toolCalls || []).forEach((tc, i) => {
      const idx = turn.omitIndex ? undefined : i;
      const mk = (fn: any, extra: any = {}) => {
        const call: any = { function: fn, ...extra };
        if (idx !== undefined) call.index = idx;
        else call.index = 0; // schema requires an int; "omitted" upstreams effectively collapse to 0
        return { ...base, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] };
      };
      const a = tc.arguments;
      const mid = Math.floor(a.length / 2);
      chunks.push(mk({ name: tc.name, arguments: "" }, { id: tc.id ?? `call_${requests.length}_${i}`, type: "function" }));
      chunks.push(mk({ arguments: a.slice(0, mid), ...(turn.repeatNameInEveryChunk ? { name: tc.name } : {}) }));
      chunks.push(mk({ arguments: a.slice(mid), ...(turn.repeatNameInEveryChunk ? { name: tc.name } : {}) }));
    });
    const promptTokens = turn.promptTokens ?? Math.ceil(bodyText.length / 4);
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 50,
        total_tokens: promptTokens + 50,
        prompt_tokens_details: { cached_tokens: turn.cachedTokens ?? 0 },
        cost: 0.0001
      }
    });
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

/** What the model actually saw for its most recent tool calls in a given request. */
export function lastToolResults(body: any): string[] {
  const msgs: any[] = body.messages || [];
  const out: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "tool") out.unshift(String(m.content));
    else if (m.role === "assistant") break;
  }
  return out;
}
