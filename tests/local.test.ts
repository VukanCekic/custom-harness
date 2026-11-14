/**
 * The "local" backend end to end: the real agent loop and callLLM, talking to
 * a mocked OpenAI-compatible server instead of OpenRouter. No OpenRouter key
 * is set - the local backend must not need one.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "harness-local-"));
execSync("git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false", { cwd: WORK });
fs.writeFileSync(path.join(WORK, "README.md"), "# demo\n");
execSync("git add . && git commit -qm init", { cwd: WORK });
process.chdir(WORK);

process.env.LLM_BACKEND = "local";
process.env.LOCAL_BASE_URL = "http://local.test/v1/"; // trailing slash on purpose
process.env.LOCAL_MODEL = "qwen3-8b";
process.env.LOCAL_API_KEY = "local-test-key";
process.env.SESSION_DIR = path.join(WORK, "..", `${path.basename(WORK)}-sessions`);
delete process.env.OPENROUTER_API_KEY;
delete process.env.MODEL;
delete process.env.PROVIDER_ONLY;

const mock = await import("./helpers/mock.js");
mock.install();
const mockFetch = globalThis.fetch;
const { runAgent } = await import("../src/agent.js");
const { callLLM, ledger, usesBreakpoints } = await import("../src/llm.js");
const { checkServer } = await import("../src/openaiCompat.js");
const { config } = await import("../src/config.js");

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf-8");
const sse = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });

beforeEach(() => mock.reset());

test("config: the local backend uses the LOCAL_* settings and nothing from OpenRouter", () => {
  assert.equal(config.backend, "local");
  assert.equal(config.model, "qwen3-8b");
  assert.equal(config.baseUrl, "http://local.test/v1", "trailing slash is trimmed");
  assert.equal(config.apiKey, "local-test-key");
  assert.equal(config.provider, undefined);
  assert.equal(usesBreakpoints("anthropic/claude-sonnet"), false, "cache markers are an OpenRouter extension");
});

test("loop: a tool-call round trip works, with plain OpenAI request bodies and no OpenRouter fields", async () => {
  mock.setScript((body) => {
    const sawResult = body.messages.some((m: any) => m.role === "tool");
    if (sawResult) return { content: "Created hello.ts." };
    return { toolCalls: [{ name: "write_file", arguments: JSON.stringify({ path: "hello.ts", content: "console.log('hi');\n" }) }] };
  });
  const before = ledger.calls;

  const result = await runAgent("Create hello.ts", { onApprove: async () => true });

  assert.equal(result.finalResponse, "Created hello.ts.");
  assert.equal(fs.readFileSync(path.join(WORK, "hello.ts"), "utf-8"), "console.log('hi');\n");

  assert.ok(mock.endpoints.length >= 2);
  for (const endpoint of mock.endpoints) {
    assert.equal(endpoint.url, "http://local.test/v1/chat/completions");
    assert.equal(endpoint.authorization, "Bearer local-test-key");
  }
  for (const body of mock.requests) {
    assert.equal(body.model, "qwen3-8b");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.ok(!("provider" in body), "OpenRouter routing is not sent to a local server");
  }
  const raw = mock.rawBodies.join("\n");
  for (const camel of ["toolCalls", "toolCallId", "reasoningDetails", "cacheControl", "cache_control"]) {
    assert.ok(!raw.includes(camel), `${camel} must not reach a local server`);
  }

  const second = mock.requests.at(-1);
  const assistant = second.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, "write_file");
  const toolMessage = second.messages.find((m: any) => m.role === "tool");
  assert.equal(toolMessage.tool_call_id, assistant.tool_calls[0].id);

  // Tokens are counted; there is no price, so the cost is a clean zero.
  assert.ok(ledger.calls >= before + 2);
  assert.ok(ledger.promptTokens > 0);
  assert.equal(ledger.cost, 0);
});

test("callLLM on a real LM Studio capture: tool call assembled, thinking kept out of the answer, usage counted", async () => {
  globalThis.fetch = async () => sse(fixture("lmstudio-qwen3-8b.toolcall.sse"));
  try {
    const tools = JSON.parse(fixture("lmstudio-qwen3-8b.toolcall.request.json")).tools;
    const result = await callLLM([{ role: "user", content: "What is in the file a.txt? Use the tool." }], tools);

    assert.equal(result.message.content, null, "thinking is not the answer");
    assert.equal(result.message.toolCalls?.length, 1);
    const call = result.message.toolCalls![0];
    assert.equal(call.function.name, "read_file");
    assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.txt" });
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.usage?.prompt_tokens, 156);
    assert.equal(result.usage?.reasoning_tokens, 85);
    assert.equal(result.usage?.cost, null);
    assert.ok(result.metrics.time_to_first_token_ms !== null, "reasoning tokens count as the first token");

  } finally {
    globalThis.fetch = mockFetch;
  }
});

test("callLLM on a real LM Studio capture: the user sees the answer, not the thinking", async () => {
  globalThis.fetch = async () => sse(fixture("lmstudio-qwen3-8b.text.sse"));
  try {
    const streamed: string[] = [];
    const result = await callLLM([{ role: "user", content: "Say hi" }], undefined, { onChunk: (c) => streamed.push(c) });
    assert.equal(result.message.content, "Hi there! 😊 How can I assist you today?");
    assert.equal(streamed.join(""), result.message.content);
    assert.equal(result.finishReason, "stop");
  } finally {
    globalThis.fetch = mockFetch;
  }
});

test("a 503 is retried, a 400 is not", async () => {
  mock.setScript((_body, i) => (i === 0 ? { status: 503 } : { content: "recovered" }));
  const result = await callLLM([{ role: "user", content: "hi" }]);
  assert.equal(result.message.content, "recovered");
  assert.equal(mock.requests.length, 2);

  mock.reset();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "context length exceeded" } }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  try {
    await assert.rejects(callLLM([{ role: "user", content: "hi" }]), /HTTP 400: context length exceeded/);
  } finally {
    globalThis.fetch = mockFetch;
  }
});

test("checkServer: says what to do when the server is down, the key is wrong or the model is missing", async () => {
  try {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const down = await checkServer("http://local.test/v1", "qwen3-8b");
    assert.equal(down.ok, false);
    assert.match((down as any).message, /Start the server/);

    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.match(((await checkServer("http://local.test/v1", "qwen3-8b")) as any).message, /LOCAL_API_KEY/);

    const models = { data: [{ id: "qwen3-8b" }, { id: "text-embedding-nomic-embed-text-v1.5" }] };
    globalThis.fetch = async () => new Response(JSON.stringify(models), { status: 200 });
    assert.deepEqual(await checkServer("http://local.test/v1", "qwen3-8b"), { ok: true, models: models.data.map((m) => m.id) });
    const missing = await checkServer("http://local.test/v1", "qwen3-9b");
    assert.equal(missing.ok, false);
    assert.match((missing as any).message, /no model "qwen3-9b"[\s\S]*qwen3-8b/);
  } finally {
    globalThis.fetch = mockFetch;
  }
});

test("sampling, max_tokens and the thinking switch reach the wire; what is not set is left out", async () => {
  mock.setScript(() => ({ content: "ok" }));
  const messages = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }];
  const saved = { sampling: config.sampling, thinking: config.thinking, maxOutputTokens: config.maxOutputTokens };
  try {
    await callLLM(messages, null);
    for (const field of ["temperature", "top_p", "top_k", "presence_penalty", "seed", "max_tokens"]) {
      assert.ok(!(field in mock.requests[0]), `${field} is not sent unless set`);
    }
    assert.equal(mock.requests[0].messages[0].content, "sys");

    mock.reset();
    config.sampling = { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5, seed: 7 };
    config.thinking = "off";
    config.maxOutputTokens = 8192;
    await callLLM(messages, null);
    const body = mock.requests[0];
    assert.deepEqual(
      [body.temperature, body.top_p, body.top_k, body.presence_penalty, body.seed, body.max_tokens],
      [0.6, 0.95, 20, 1.5, 7, 8192]
    );
    assert.equal(body.messages[0].content, "sys\n\n/no_think", "Qwen3's soft switch, on the first system message only");
    assert.equal(body.messages[1].content, "hi");
    assert.equal(messages[0].content, "sys", "the transcript itself is not touched");
  } finally {
    Object.assign(config, saved);
  }
});
