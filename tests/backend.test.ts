/**
 * Choosing between the remote (OpenRouter) and local backends. config.ts reads
 * the environment once at import, so each case runs in a fresh process, from an
 * empty directory so no .env gets loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONFIG = pathToFileURL(path.resolve(import.meta.dirname, "../src/config.ts")).href;
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "harness-backend-"));

function load(env: Record<string, string>, args: string[] = []) {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(LLM_BACKEND|MODEL|LOCAL_.*|OPENROUTER_API_KEY|CONTEXT_WINDOW|PROVIDER_ONLY)$/.test(key)) clean[key] = value;
  }
  const code = `const { config } = await import(${JSON.stringify(CONFIG)});
    console.log(JSON.stringify({ backend: config.backend, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey, ctx: config.contextWindow, provider: config.provider ?? null }));`;
  const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code, "--", ...args], {
    cwd: EMPTY,
    env: { ...clean, ...env, NODE_PATH: path.resolve(import.meta.dirname, "../node_modules") },
    encoding: "utf-8"
  });
  return { status: run.status, out: run.stdout.trim(), err: run.stderr };
}

test("default is remote: OpenRouter, the MODEL and key from the environment", () => {
  const run = load({ OPENROUTER_API_KEY: "sk-or-x", MODEL: "anthropic/claude-sonnet", LOCAL_MODEL: "ignored" });
  assert.equal(run.status, 0, run.err);
  assert.deepEqual(JSON.parse(run.out), {
    backend: "remote", model: "anthropic/claude-sonnet", baseUrl: "", apiKey: "sk-or-x", ctx: 64000, provider: null
  });
});

test("LLM_BACKEND=local switches to the LOCAL_* settings, with LM Studio defaults", () => {
  const run = load({ LLM_BACKEND: "local", OPENROUTER_API_KEY: "sk-or-x", MODEL: "deepseek/x" });
  assert.equal(run.status, 0, run.err);
  assert.deepEqual(JSON.parse(run.out), {
    backend: "local", model: "qwen3-8b", baseUrl: "http://localhost:1234/v1", apiKey: "", ctx: 32000, provider: null
  });
});

test("LOCAL_MODEL, LOCAL_BASE_URL, LOCAL_API_KEY and CONTEXT_WINDOW override the defaults", () => {
  const run = load({ LLM_BACKEND: "local", LOCAL_MODEL: "m", LOCAL_BASE_URL: "http://127.0.0.1:8080/v1/", LOCAL_API_KEY: "k", CONTEXT_WINDOW: "40000" });
  assert.deepEqual(JSON.parse(run.out), {
    backend: "local", model: "m", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k", ctx: 40000, provider: null
  });
});

test("--local and --remote beat LLM_BACKEND, so one command can flip it", () => {
  assert.equal(JSON.parse(load({ LLM_BACKEND: "remote" }, ["--local"]).out).backend, "local");
  assert.equal(JSON.parse(load({ LLM_BACKEND: "local" }, ["--remote"]).out).backend, "remote");
});

test("PROVIDER_ONLY routing applies to the remote backend only", () => {
  const remote = JSON.parse(load({ PROVIDER_ONLY: "together" }).out);
  assert.deepEqual(remote.provider, { only: ["together"], allowFallbacks: false });
  assert.equal(JSON.parse(load({ PROVIDER_ONLY: "together", LLM_BACKEND: "local" }).out).provider, null);
});

test("an unknown LLM_BACKEND is an error, never a silent fall back to the paid API", () => {
  const run = load({ LLM_BACKEND: "lcoal" });
  assert.notEqual(run.status, 0);
  assert.match(run.err, /LLM_BACKEND must be "remote" or "local", got "lcoal"/);
});
