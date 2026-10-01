// [C-4] Mid-turn compaction with a parallel read of ten files: does the cut
// land past results the model has not read yet? Default CONTEXT_WINDOW.
import { at, offline } from "./_root.mts";
offline();
const mock = await import(at("tests/helpers/mock.ts"));
mock.install();
mock.setScript(() => ({ content: "## Goal\nread ten files" }));
const { compact, tailStart } = await import(at("src/compact.ts"));
const { cap, sweep } = await import(at("src/history.ts"));
const { config } = await import(at("src/config.ts"));
const calls = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }));
const messages: any[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "Read the ten modules and summarise the API." },
  { role: "assistant", content: "Reading all ten at once.", toolCalls: calls },
  ...calls.map((c, i) => ({ role: "tool", toolCallId: c.id, content: cap(`// module ${i}\n` + "export const x = 1;\n".repeat(700)) }))
];
const tail = config.contextWindow * config.compactTo;
console.log(`[C-4] CONTEXT_WINDOW=${config.contextWindow}, tail kept verbatim ${tail} tokens; ten unread results; tailStart() cuts at ${tailStart(messages, tail)} of ${messages.length}`);
await compact(messages);
console.log(`      after compaction: [${messages.map((m) => m.role).join(", ")}] - unread results still visible: ${messages.filter((m) => m.role === "tool").length}/10`);
sweep();
