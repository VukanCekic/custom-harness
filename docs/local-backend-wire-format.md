# Local backend: what the servers actually send

Captured 2026-10-09 from **LM Studio 0.4.26** serving **Qwen3-8B (Q8_0)**, context 40960.
Raw responses: `tests/fixtures/lmstudio-qwen3-8b.*.sse` (replayed by `tests/local.test.ts`
and `tests/openai-compat.test.ts`). Requests used `stream: true` and
`stream_options: { include_usage: true }`.

| Question | Observed |
|---|---|
| SSE framing | `data: {json}` lines, LF only, blank line between events, ends with `data: [DONE]`. No comment lines. |
| Where is the thinking? | `delta.reasoning_content`, before any `content`. Never inside `content`. |
| Where is usage? | One last chunk with `"choices": []` and `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, `completion_tokens_details.reasoning_tokens`). |
| Cost / cached tokens | Neither is sent (`prompt_tokens_details` absent). The harness records cost `0` and cached `0`. |
| Tool-call deltas | First fragment: `index 0`, `id`, `type: "function"`, `function.name`, `arguments: ""`. Then `arguments` only, 1-2 characters per chunk. Name and id are not repeated. |
| `finish_reason` | `"stop"` or `"tool_calls"`, on the last content chunk, before the usage chunk. |
| Non-streaming | `message.tool_calls` is `[]` when there is none (the harness only streams). |

Not yet captured: llama-server and Ollama. llama-server's README documents `reasoning_content`
(`--reasoning-format`), `prompt_tokens_details.cached_tokens` and `--jinja` for tool calls; Ollama
documents no `tool_choice`. Re-run the probes against them before trusting those.

## Design

The transcript stays in the OpenRouter SDK's camelCase shape (sessions and `--resume` use it).
`src/openaiCompat.ts` translates at the wire only: `toWireMessages` out, `parseSSE` +
`normaliseChunk` back in, so `callLLM`'s loop is identical for both backends.
`toWireMessages` is also the translation needed to export transcripts as training data.
