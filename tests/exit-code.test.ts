/**
 * `index.ts --local "<prompt>"` as a script or an eval runs it: the exit code
 * is the only thing they can rely on to tell a finished turn from a failed one.
 * Runs the real process against a tiny local server.
 *
 * Regressions: a provider error used to exit 0 (the error was printed and the
 * process ended normally), and ending with process.exit() could abort Node on
 * Windows with a libuv assertion (0xC0000409) even after a good turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

const ENTRY = path.resolve(import.meta.dirname, "../src/index.ts");
const TSX = path.resolve(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs");

type Mode = "text" | "http400" | "stall";

async function runHarness(mode: Mode) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake" }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      if (mode === "http400") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "bad request" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      if (mode === "stall") return; // one chunk, then silence
      res.write(chunk({ content: "done" }));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "harness-exit-sess-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-exit-"));
  const env = { ...process.env, LLM_BACKEND: "local", LOCAL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, LOCAL_MODEL: "fake", SESSION_DIR: sessions, STALL_MS: "1500", STREAM: "0", NO_COLOR: "1" };
  delete env.OPENROUTER_API_KEY;
  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [TSX, ENTRY, "--local", "say hi"], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
      child.on("close", resolve);
    });
    const log = fs.readdirSync(sessions).find((f) => f.endsWith(".jsonl"));
    const records = log ? fs.readFileSync(path.join(sessions, log), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { code, turn: records.find((r) => r.type === "turn"), steps: records.filter((r) => r.type === "step") };
  } finally {
    for (const dir of [sessions, cwd]) fs.rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    server.close();
  }
}

test("a finished one-shot turn exits 0, with a turn record and a step record", async () => {
  const run = await runHarness("text");
  assert.equal(run.code, 0);
  assert.equal(run.turn.stop_reason, "done");
  assert.equal(run.turn.error, undefined);
  assert.equal(run.steps.length, 1);
});

test("a provider error exits non-zero, and the turn record says what failed", async () => {
  const run = await runHarness("http400");
  assert.equal(run.code, 3);
  assert.match(run.turn.error.message, /HTTP 400/);
});

test("a stalled provider exits non-zero too", async () => {
  const run = await runHarness("stall");
  assert.equal(run.code, 3);
  assert.match(run.turn.error.message, /no data from the provider/);
});
