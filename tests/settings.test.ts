/**
 * The settings a run's results depend on - sampling, token budgets, the
 * thinking switch - are read from the environment once at import, so each case
 * runs in a fresh process from an empty directory (no .env). A typo in one of
 * them must stop the run: a setting that is silently ignored changes what the
 * run measures and leaves no trace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { NO_THINK, requestBody, samplingFields, toWireMessages } from "../src/openaiCompat.js";

const CONFIG = pathToFileURL(path.resolve(import.meta.dirname, "../src/config.ts")).href;
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "harness-settings-"));
const OWN = /^(LLM_|LOCAL_|MODEL$|OPENROUTER_API_KEY$|MAX_OUTPUT_TOKENS$|MAX_TURN_TOKENS$|PROVIDER_ONLY$)/;

function load(env: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !OWN.test(key)) clean[key] = value;
  const code = `const { config, describeSettings } = await import(${JSON.stringify(CONFIG)});
    console.log(JSON.stringify(describeSettings()));`;
  const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], {
    cwd: EMPTY,
    env: { ...clean, ...env, NODE_PATH: path.resolve(import.meta.dirname, "../node_modules") },
    encoding: "utf-8"
  });
  return { status: run.status, out: run.stdout.trim(), err: run.stderr };
}

test("nothing is sent that was not asked for: unset means the provider's default, and the log says so", () => {
  const run = load({ LLM_BACKEND: "local" });
  assert.equal(run.status, 0, run.err);
  const settings = JSON.parse(run.out);
  assert.deepEqual(settings.sampling, {});
  assert.equal(settings.thinking, "default");
  assert.equal(settings.max_output_tokens, null);
  assert.equal(settings.max_turn_tokens, null);
});

test("sampling, budgets and thinking come from the environment, and are described as they were in effect", () => {
  const run = load({
    LLM_BACKEND: "local",
    LLM_TEMPERATURE: "0.6",
    LLM_TOP_P: "0.95",
    LLM_TOP_K: "20",
    LLM_PRESENCE_PENALTY: "1.5",
    LLM_SEED: "42",
    MAX_OUTPUT_TOKENS: "8192",
    MAX_TURN_TOKENS: "100000",
    LOCAL_THINKING: "off"
  });
  assert.equal(run.status, 0, run.err);
  const settings = JSON.parse(run.out);
  assert.deepEqual(settings.sampling, { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5, seed: 42 });
  assert.equal(settings.thinking, "off");
  assert.equal(settings.max_output_tokens, 8192);
  assert.equal(settings.max_turn_tokens, 100000);
});

test("a malformed or out-of-range setting is an error, not a silent default", () => {
  for (const env of [
    { LLM_TEMPERATURE: "hot" },
    { LLM_TEMPERATURE: "3" },
    { LLM_TOP_P: "1.5" },
    { LLM_TOP_K: "2.5" },
    { LLM_SEED: "x" },
    { MAX_OUTPUT_TOKENS: "-1" },
    { LOCAL_THINKING: "maybe" }
  ]) {
    const run = load({ LLM_BACKEND: "local", ...env });
    assert.notEqual(run.status, 0, `${JSON.stringify(env)} should fail`);
    assert.match(run.err, new RegExp(Object.keys(env)[0]));
  }
});

test("LOCAL_THINKING sits in .env beside the remote settings without effect", () => {
  const remote = load({ LOCAL_THINKING: "off" });
  assert.equal(remote.status, 0, remote.err);
  assert.equal(JSON.parse(remote.out).thinking, "default", "only the local backend applies it");
  assert.equal(JSON.parse(load({ LLM_BACKEND: "local", LOCAL_THINKING: "off" }).out).thinking, "off");
});

test("samplingFields uses the OpenAI field names and skips what is unset", () => {
  assert.deepEqual(samplingFields({}), {});
  assert.deepEqual(samplingFields({ temperature: 0, topK: 0, seed: 0 }), { temperature: 0, top_k: 0, seed: 0 }, "zero is a value, not 'unset'");
  assert.deepEqual(samplingFields({ topP: 0.8, presencePenalty: 1 }), { top_p: 0.8, presence_penalty: 1 });
});

test("requestBody: thinking off adds the soft switch to the first system message only, on the wire only", () => {
  const messages: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "system", content: "second" }
  ];
  const body: any = requestBody({ baseUrl: "http://x", model: "m", messages, thinking: "off", sampling: { temperature: 0.7 }, maxTokens: 100 });
  assert.equal(body.messages[0].content, `sys${NO_THINK}`);
  assert.equal(body.messages[2].content, "second");
  assert.equal(messages[0].content, "sys");
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.stream, true);

  const plain: any = requestBody({ baseUrl: "http://x", model: "m", messages });
  assert.equal(plain.messages[0].content, "sys");
  assert.ok(!("temperature" in plain) && !("max_tokens" in plain));
  assert.equal(toWireMessages(messages)[0].content, "sys");
});
