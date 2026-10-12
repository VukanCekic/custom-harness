/**
 * The local backend's wire layer: SSE parsing, chunk normalising and message
 * translation. Pure functions - no config, no network. The captures in
 * tests/fixtures/ are real LM Studio + Qwen3-8B responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { parseSSE, normaliseChunk, toWireMessages } from "../src/openaiCompat.js";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf-8");

/** A body delivered in the given pieces - network reads do not respect event boundaries. */
function body(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const out: any[] = [];
  for await (const event of parseSSE(stream)) out.push(event);
  return out;
}

test("parseSSE: events split across reads, CRLF, comments, no space after data:", async () => {
  const events = await collect(
    body(
      'data: {"a":',
      "1}\n",
      "\n: keep-alive\n\ndata:{",
      '"b":2}\r\n\r\n',
      'event: x\ndata: {"c":3}\n\n',
      "data: [DONE]\n\n",
      'data: {"never":"read"}\n\n'
    )
  );
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("parseSSE: the last event is delivered even without a closing blank line", async () => {
  assert.deepEqual(await collect(body('data: {"a":1}\n\ndata: {"b":2}')), [{ a: 1 }, { b: 2 }]);
});

test("parseSSE: a multibyte character split between reads survives", async () => {
  const bytes = new TextEncoder().encode('data: {"t":"hi 😊"}\n\n');
  const cut = bytes.indexOf(0xf0) + 2; // inside the emoji
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    }
  });
  assert.deepEqual(await collect(stream), [{ t: "hi 😊" }]);
});

test("parseSSE: an unreadable event is an error, not silence", async () => {
  await assert.rejects(collect(body("data: {oops\n\n")), /Unreadable event/);
});

test("real capture, plain answer: thinking is separate from the answer, usage arrives last with no choices", async () => {
  const chunks = (await collect(body(fixture("lmstudio-qwen3-8b.text.sse")))).map(normaliseChunk);
  const content = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
  const reasoning = chunks.map((c) => c.choices[0]?.delta.reasoning ?? "").join("");
  assert.equal(content, "Hi there! 😊 How can I assist you today?");
  assert.match(reasoning, /^Okay, the user said/, "reasoning_content is mapped to reasoning");
  assert.ok(!content.includes("Okay, the user"), "thinking never leaks into the answer");

  const last = chunks.at(-1)!;
  assert.deepEqual(last.choices, [], "the usage chunk has no choices");
  assert.equal(last.usage?.promptTokens, 10);
  assert.equal(last.usage?.completionTokens, 124);
  assert.equal(last.usage?.completionTokensDetails?.reasoningTokens, 107);
  assert.equal(last.usage?.cost, undefined, "a local server does not price anything");
  assert.equal(chunks.filter((c) => c.choices[0]?.finishReason === "stop").length, 1);
});

test("real capture, tool call: name once, argument fragments, finish_reason tool_calls", async () => {
  const chunks = (await collect(body(fixture("lmstudio-qwen3-8b.toolcall.sse")))).map(normaliseChunk);
  const calls = chunks.flatMap((c) => c.choices[0]?.delta.toolCalls ?? []);
  assert.equal(calls[0].function?.name, "read_file");
  assert.ok(calls[0].id, "the id comes with the first fragment");
  assert.ok(calls.slice(1).every((call) => !call.function?.name && !call.id), "later fragments carry arguments only");
  assert.ok(calls.length > 3, "arguments really are fragmented");
  assert.ok(calls.every((call) => call.index === 0));

  const args = calls.map((call) => call.function?.arguments ?? "").join("");
  assert.deepEqual(JSON.parse(args), { path: "a.txt" });
  assert.equal(chunks.filter((c) => c.choices[0]?.finishReason === "tool_calls").length, 1);
  assert.equal(chunks.at(-1)!.usage?.promptTokens, 156);
});

test("normaliseChunk: an in-band error, a null delta field and a missing choices array", () => {
  assert.deepEqual(normaliseChunk({ error: { code: 502, message: "boom" } }).error, { code: 502, message: "boom" });
  assert.deepEqual(normaliseChunk({ error: { message: "no code" } }).error, { code: "unknown", message: "no code" });
  const chunk = normaliseChunk({ choices: [{ delta: { content: null, tool_calls: null }, finish_reason: null }] });
  assert.equal(chunk.choices[0].delta.content, undefined);
  assert.equal(chunk.choices[0].delta.toolCalls, undefined);
  assert.deepEqual(normaliseChunk({}).choices, []);
});

test("normaliseChunk: servers that report cached tokens (llama-server) keep them; `reasoning` is accepted too", () => {
  const chunk = normaliseChunk({
    choices: [{ delta: { reasoning: "hmm" } }],
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }
  });
  assert.equal(chunk.choices[0].delta.reasoning, "hmm");
  assert.equal(chunk.usage?.promptTokensDetails?.cachedTokens, 80);
  assert.equal(chunk.usage?.totalTokens, 105, "total is derived when the server omits it");
});

test("toWireMessages: snake_case on the wire, thinking and cache markers dropped", () => {
  const messages = [
    { role: "system", content: [{ type: "text", text: "be brief", cacheControl: { type: "ephemeral" } }] },
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
      reasoningDetails: [{ type: "reasoning.text", text: "secret thoughts" }]
    },
    { role: "tool", toolCallId: "call_1", content: "1\thello" },
    { role: "assistant", content: "It says hello." }
  ] as unknown as ChatMessages[];

  const wire = toWireMessages(messages);
  assert.deepEqual(wire, [
    { role: "system", content: "be brief" },
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]
    },
    { role: "tool", tool_call_id: "call_1", content: "1\thello" },
    { role: "assistant", content: "It says hello." }
  ]);
  const json = JSON.stringify(wire);
  for (const leaked of ["toolCalls", "toolCallId", "reasoningDetails", "cacheControl", "secret thoughts"]) {
    assert.ok(!json.includes(leaked), `${leaked} must not reach the server`);
  }
});
