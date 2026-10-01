import { test } from "node:test";
import nodeAssert from "node:assert/strict";
import fs from "node:fs";
import { cap, sweep, strip, fit, locked, live, estimate, SPILLS, TRIMMED, STRIPPED, DROPPED, HANDOFF_OPENING } from "../src/history.js";
import { safeBoundary, tailStart, render, pinned, HANDOFF } from "../src/compact.js";
import { readFileTool } from "../src/tools/readFile.js";
import type { ChatMessages } from "@openrouter/sdk/models";

function assert(condition: boolean, msg: string) {
  nodeAssert.ok(condition, msg);
}

const handoff = (notes: string) => `${HANDOFF_OPENING} out of the context window.\n${notes}\n</summary>`;

async function testCapAndSweep() {
  const smallText = "Hello world";
  assert(cap(smallText) === smallText, "Small text is not capped");

  const largeText = "A".repeat(15_000) + "\nFAIL: expected 3, got 4";
  const cappedLarge = cap(largeText);
  assert(cappedLarge.length < 15_000, "Large text is capped");
  assert(cappedLarge.includes(TRIMMED), "Capped text includes TRIMMED marker");
  assert(cappedLarge.endsWith("FAIL: expected 3, got 4"), "Cap keeps the tail, where test runners print the verdict");
  assert(SPILLS.length > 0, "Spills array contains the spilled file path");

  const spilledPath = SPILLS[0];
  assert(fs.readFileSync(spilledPath, "utf-8") === largeText, "Spilled file has full unmodified text");

  const emoji = "a".repeat(6_999) + "\u{1F600}" + "b".repeat(5_000);
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cap(emoji)), "Cap never splits a surrogate pair");

  // A subagent's scope is separate: sweeping it leaves the parent's file alone.
  const childScope: string[] = [];
  cap("C".repeat(15_000), childScope);
  sweep(childScope);
  assert(fs.existsSync(spilledPath), "Sweeping a child scope does not delete the parent's spill");

  sweep();
  assert(!fs.existsSync(spilledPath), "sweep() removes spilled file from disk");
  assert(SPILLS.length === 0, "sweep() clears SPILLS list");
}

function testStripAndLocked() {
  const messages: ChatMessages[] = [
    { role: "system", content: "You are an agent." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Running tool..." },
    { role: "tool", content: "B".repeat(1000) } as any,
    { role: "assistant", content: "Done" }
  ];

  assert(locked(messages) === 0, "locked is 0 when no summary exists");
  assert(strip(messages) === 1, "strip shrinks 1 tool message");
  assert((messages[3] as any).content.includes(STRIPPED), "Tool message now has STRIPPED marker");
  assert(strip(messages) === 0, "Calling strip a second time does not re-shrink (idempotent)");

  const messagesWithSummary: ChatMessages[] = [
    { role: "system", content: "You are an agent." },
    { role: "user", content: handoff("Past work summary") },
    { role: "assistant", content: "I am ready." },
    { role: "tool", content: "C".repeat(500) } as any
  ];
  assert(locked(messagesWithSummary) === 2, "locked identifies prefix up to the handoff note (index 2)");
  assert(strip(messagesWithSummary) === 1, "Tool message after locked prefix was stripped");

  const lookalikes: ChatMessages[] = [
    { role: "system", content: "s" },
    { role: "tool", content: "/// <summary>\n/// Adds two numbers.\n/// </summary>\n" + "c".repeat(900) } as any,
    { role: "tool", content: "<details><summary>Click</summary>body</details>" } as any,
    { role: "user", content: "what does <summary> mean in HTML?" }
  ];
  assert(locked(lookalikes) === 0, "<summary> in tool output or user text does not lock the prefix");

  const midTurn: ChatMessages[] = [
    { role: "system", content: "s" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", type: "function", function: { name: "bash", arguments: "{}" } }] } as any,
    { role: "tool", toolCallId: "a", content: "x".repeat(900) } as any
  ];
  assert(live(midTurn) === 2 && strip(midTurn, true) === 0, "strip(protectLive) leaves the unread results alone");
}

function testSafeBoundaryAndTailStart() {
  const transcript: ChatMessages[] = [
    { role: "system", content: "System" }, // 0
    { role: "user", content: "Prompt 1" },  // 1
    {
      role: "assistant",
      content: "Let me check files",
      toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"foo"}' } }]
    } as any, // 2
    { role: "tool", toolCallId: "c1", content: "File content" } as any, // 3
    { role: "assistant", content: "I read foo" }, // 4
    { role: "user", content: "Prompt 2" }, // 5
    {
      role: "assistant",
      content: "Let me run bash",
      toolCalls: [{ id: "c2", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }]
    } as any, // 6
    { role: "tool", toolCallId: "c2", content: "file1 file2" } as any, // 7
    { role: "assistant", content: "Here are the files" } // 8
  ];

  assert(safeBoundary(transcript, 3) === 4, "safeBoundary steps past a tool result to index 4");
  assert(safeBoundary(transcript, 5) === 5, "safeBoundary accepts clean user turn boundary at index 5");
  assert(tailStart(transcript, 100_000) === 1, "tailStart with a large budget keeps everything");
}

function testRenderAndPinning() {
  const earlier = HANDOFF.replace(/\{(requests|summary)\}/g, (_, k) =>
    k === "requests" ? "<request>\nBuild it in playground/. Do not touch src/.\n</request>" : "## Goal\nold notes"
  );
  const messages: ChatMessages[] = [
    { role: "system", content: "System prompt" },
    { role: "user", content: earlier },
    { role: "user", content: "Also add a power() function" },
    {
      role: "assistant",
      content: "I will write it",
      toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"app.ts"}' } }]
    } as any,
    { role: "tool", content: "File written successfully" } as any,
    { role: "assistant", content: "All done!" }
  ];

  const rendered = render(messages);
  assert(!rendered.includes("System prompt"), "render skips system message");
  assert(rendered.startsWith("EARLIER HANDOFF NOTE:"), "an earlier handoff is labelled as one, not as USER");
  assert(rendered.includes('[called write_file: {"path":"app.ts"}]'), "render includes tool call detail");
  assert(rendered.includes("TOOL RESULT: File written successfully"), "render includes tool result");

  const pins = pinned(messages.slice(1));
  assert(pins[0] === "Build it in playground/. Do not touch src/.", "requests pinned by an earlier compaction carry forward verbatim");
  assert(pins.includes("Also add a power() function"), "new user requests are pinned verbatim");
}

function testFit() {
  const make = (): ChatMessages[] => [
    { role: "system", content: "System" },
    { role: "user", content: handoff("Prefix summary") },
    { role: "assistant", content: "Turn 1" },
    { role: "tool", content: "D".repeat(5_000) } as any,
    { role: "assistant", content: "Turn 2" },
    { role: "tool", content: "E".repeat(5_000) } as any // unread: the newest step
  ];

  const messages = make();
  const result = fit(messages, 1000);
  assert(result.fits, "fit gets a reachable budget under the line");
  assert((messages[3] as any).content.includes(DROPPED) || (messages[3] as any).content.includes(STRIPPED), "the oldest READ result is shrunk first");
  const fresh = (messages[5] as any).content as string;
  assert(!fresh.includes(DROPPED), "the unread result is never replaced by a dropped marker");
  assert(fresh.includes(TRIMMED) && fresh.includes("The whole output is at"), "the unread result is squeezed to a pointer at its spill file");
  assert((messages[1] as any).content.startsWith(HANDOFF_OPENING), "Prefix summary remains untouched");
  sweep();

  const hopeless = make();
  const before = JSON.stringify(hopeless);
  const refused = fit(hopeless, 100, 5_000);
  assert(!refused.fits && JSON.stringify(hopeless) === before, "an unreachable budget changes nothing and reports fits=false");
  assert(refused.floor > 100, "fit reports the floor it could not get under");

  const small = make();
  assert(fit(small, 1_000_000).stubbed === 0 && estimate(small) > 0, "under budget, fit is a no-op");
}

async function testReadFilePagination() {
  const resultAll = await readFileTool.execute({ path: "package.json" });
  assert(resultAll.includes('"name": "custom-harness"'), "Full read works");

  const resultSlice = await readFileTool.execute({ path: "package.json", offset: 1, limit: 3 });
  assert(resultSlice.includes("[Lines 1 to 3 of"), "Header specifies line range");
  assert(resultSlice.trim().split("\n").length === 4, "Pagination returned exact line slice");
}

test("cap keeps head and tail, spills, and sweeps per scope", testCapAndSweep);
test("strip and locked", testStripAndLocked);
test("safeBoundary and tailStart never orphan a tool result", testSafeBoundaryAndTailStart);
test("render labels earlier notes; user requests are pinned", testRenderAndPinning);
test("fit is fail-safe", testFit);
test("read_file pagination", testReadFilePagination);
