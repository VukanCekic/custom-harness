/**
 * Pure functions added by the audit's Phase 2 and 3: no LLM, no repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { withBreakpoints, mergeReasoning } from "../src/llm.js";
import { observe, blame } from "../src/cache.js";
import { elide, settle, fit, strip, ELIDED, HANDOFF_OPENING } from "../src/history.js";
import { sanitize, wrapAnsi, visibleLength, cAccent } from "../src/ui.js";
import { globToRegex, matches, grepTool, globTool } from "../src/tools/search.js";
import { readFileTool } from "../src/tools/readFile.js";
import { writeTodos, clearTodos } from "../src/todos.js";
import { check, decide } from "../src/permissions.js";
import { config } from "../src/config.js";

const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

test("Anthropic breakpoints: tools, system, end of the lock, newest stable message", () => {
  const messages: ChatMessages[] = [
    { role: "system", content: "sys" },
    { role: "user", content: `${HANDOFF_OPENING} out of the window.\nnotes\n</summary>` },
    { role: "user", content: "do it" },
    { role: "assistant", content: "", toolCalls: [call("a", "bash", { command: "ls" })] } as any,
    { role: "tool", toolCallId: "a", content: "out" } as any,
    { role: "user", content: "<env>reminder</env>" }
  ];
  const tools = [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }] as any;
  const out = withBreakpoints(messages, tools, 5);
  const markedAt = out.messages.map((m: any, i) => (Array.isArray(m.content) && m.content[0].cacheControl ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(markedAt, [0, 1, 4], "system, handoff note, last stable message - never the reminder");
  assert.equal((out.tools![1] as any).cacheControl.type, "ephemeral");
  assert.equal((out.tools![0] as any).cacheControl, undefined);
  assert.equal(typeof messages[0].content, "string", "the transcript itself is not modified");
});

test("reasoning details are merged across stream chunks", () => {
  const into = new Map<number, any>();
  mergeReasoning(into, [{ type: "reasoning.text", index: 0, text: "Let me " }]);
  mergeReasoning(into, [{ type: "reasoning.text", index: 0, text: "think.", signature: "sig" }]);
  mergeReasoning(into, [{ type: "reasoning.encrypted", index: 1, data: "abc" }]);
  assert.deepEqual(into.get(0), { type: "reasoning.text", index: 0, text: "Let me think.", signature: "sig" });
  assert.equal(into.get(1).data, "abc");
});

test("cache telemetry finds the first divergent message and names the cause", () => {
  const messages: ChatMessages[] = [
    { role: "system", content: "s" },
    { role: "user", content: "q" },
    { role: "tool", toolCallId: "x", content: "y".repeat(400) } as any
  ];
  assert.equal(observe(messages, 3, []), null, "first request: nothing to compare");
  messages.push({ role: "assistant", content: "more" });
  assert.equal(observe(messages, 4, []), null, "pure append keeps the whole prefix");
  strip(messages);
  blame(messages, "strip");
  const broke = observe(messages, 4, []);
  assert.ok(broke);
  assert.equal(broke.at, 2);
  assert.equal(broke.reason, "strip");
  assert.ok(broke.reused > 0 && broke.reused < 1);
  assert.equal(observe(messages, 4, [{ type: "function", function: { name: "new" } }] as any)?.reason, "tool set changed");
});

test("finished tool calls have their bulky arguments elided", () => {
  const big = "x".repeat(5_000);
  const messages: ChatMessages[] = [
    { role: "system", content: "s" },
    { role: "assistant", content: "", reasoningDetails: [{ type: "reasoning.text", text: "hm" }], toolCalls: [
      call("a", "write_file", { path: "big.ts", content: big }),
      call("b", "bash", { command: "ls" }),
      { id: "c", type: "function", function: { name: "write_file", arguments: '{"path": "cut' } }
    ] } as any
  ];
  assert.equal(elide(messages), 1);
  const calls = (messages[1] as any).toolCalls;
  assert.match(JSON.parse(calls[0].function.arguments).content, /^\[content elided: 5000 chars written to big\.ts/);
  assert.equal(calls[1].function.arguments, '{"command":"ls"}', "small arguments stay verbatim");
  assert.equal(calls[2].function.arguments, '{"path": "cut', "invalid JSON is left alone");
  assert.equal((messages[1] as any).reasoningDetails, undefined, "thinking blocks go at the turn boundary");
  assert.equal(elide(messages), 0, "idempotent");
  assert.ok(JSON.parse(calls[0].function.arguments).content.startsWith(ELIDED));
});

test("strip waits until the transcript is big enough to pay for it", () => {
  const small: ChatMessages[] = [{ role: "system", content: "s" }, { role: "tool", toolCallId: "a", content: "z".repeat(1_000) } as any];
  assert.equal(settle(small), 0, "a small transcript keeps its results (and its cache)");
  const threshold = config.contextWindow * config.stripAfter;
  assert.ok(settle(small, threshold) > 0, "past STRIP_AFTER of the window it strips");
});

test("fit can elide a huge write_file argument it used to treat as irreducible", () => {
  const messages: ChatMessages[] = [
    { role: "system", content: "s" },
    { role: "user", content: "write it" },
    { role: "assistant", content: "", toolCalls: [call("a", "write_file", { path: "huge.txt", content: "q".repeat(200_000) })] } as any,
    { role: "tool", toolCallId: "a", content: "Wrote huge.txt" } as any,
    { role: "assistant", content: "done" }
  ];
  const result = fit(messages, 5_000);
  assert.ok(result.fits, `fits (floor ${result.floor})`);
  assert.equal(result.elided, 1);
  assert.equal((messages[3] as any).content, "Wrote huge.txt", "the result itself is untouched");
});

test("tool output is sanitised before printing, and long lines wrap", () => {
  const nasty = "ok\x1b]0;pwned title\x07 \x1b[2J\x1b[31mred\x1b[0m\rprogress 10%\rprogress 100%\x07";
  const clean = sanitize(nasty);
  assert.ok(!clean.includes("\x1b") && !clean.includes("\x07"), "no escape or bell characters survive");
  assert.equal(clean, "progress 100%", "a carriage-return progress bar collapses to its last state");
  const pieces = wrapAnsi(cAccent("a".repeat(25)), 10);
  assert.equal(pieces.length, 3);
  assert.ok(pieces.every((p) => visibleLength(p) <= 10));
  assert.ok(pieces[1].startsWith("\x1b[38;2;"), "the colour carries onto the next piece");
});

test("globs", () => {
  assert.ok(globToRegex("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegex("src/**/*.ts").test("src/c.ts"));
  assert.ok(!globToRegex("src/*.ts").test("src/a/c.ts"));
  assert.ok(matches("deep/dir/file.test.ts", "*.test.ts"), "a pattern without / matches the file name anywhere");
  assert.ok(matches("a.js", "*.{js,ts}") && !matches("a.md", "*.{js,ts}"));
});

test("grep and glob work without a shell and skip binaries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-search-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "const needle = 1;\nother\n");
  fs.writeFileSync(path.join(dir, "node_modules", "x", "b.ts"), "needle\n");
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
  const found = await grepTool.execute({ pattern: "needle", path: dir });
  assert.match(found, /src\/a\.ts:1: const needle = 1;/);
  assert.ok(!found.includes("node_modules") && !found.includes("blob.bin"));
  assert.match(await grepTool.execute({ pattern: "(", path: dir }), /invalid regular expression/);
  assert.match(await globTool.execute({ pattern: "**/*.ts", path: dir }), /src\/a\.ts/);
});

test("read_file numbers lines and refuses binaries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-read-"));
  const text = path.join(dir, "t.txt");
  fs.writeFileSync(text, "alpha\r\nbeta\n");
  assert.equal(await readFileTool.execute({ path: text }), "1\talpha\n2\tbeta\n3\t");
  assert.equal(await readFileTool.execute({ path: text, offset: 2, limit: 1 }), "[Lines 2 to 2 of 3]:\n2\tbeta");
  const bin = path.join(dir, "b.bin");
  fs.writeFileSync(bin, Buffer.from([0x50, 0x4b, 0, 0]));
  assert.match(await readFileTool.execute({ path: bin }), /binary file/);
  assert.match(await readFileTool.execute({ path: dir }), /is a directory/);
});

test("todos are validated", () => {
  clearTodos();
  assert.match(writeTodos([{ content: "a", activeForm: "A", status: "doing" as any }]), /status "doing"/);
  assert.match(writeTodos([{ content: "", activeForm: "", status: "pending" }]), /no content/);
  assert.match(writeTodos([{ content: "a", activeForm: "", status: "in_progress" }]), /\[~\] a/);
  clearTodos();
});

test("the browser is gated: eval asks, unknown hosts ask once per session", () => {
  assert.equal(check("browser", { action: "eval", js: "document.cookie" }).action, "ask");
  assert.equal(check("browser", { command: "eval 1+1" }).action, "ask", "shorthand commands are parsed the same way");
  assert.equal(check("browser", { action: "open", url: "http://localhost:3000" }).action, "allow");
  assert.equal(check("browser", { action: "open", url: "file:///etc/passwd" }).action, "ask");
  const first = check("browser", { action: "open", url: "example.com/page" });
  assert.equal(first.action, "ask");
  first.remember?.();
  assert.equal(check("browser", { command: "open https://www.example.com/other" }).action, "allow", "approved for the session, subdomains included");
  assert.equal(check("browser", { action: "snapshot" }).action, "allow");
});

test("bare head/tail at the end of a pipe no longer ask; grep outside the project does", () => {
  assert.equal(decide("git log --oneline | head", true), "allow");
  assert.equal(decide("cat package.json | tail", true), "allow");
  assert.equal(check("grep", { pattern: "x", path: "../../" }).action, "ask");
  assert.equal(check("glob", { pattern: "*" }).action, "allow");
});
