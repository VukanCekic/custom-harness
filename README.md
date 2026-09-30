# Custom Harness

A clean, extensible Node.js + TypeScript coding agent built with `@openrouter/sdk`. Features real-time streaming, tool-calling execution (with `bash`), pure model throughput tracking (tokens/second), usage cost accounting, and automatic session recording.

## Architecture

- [`src/config.ts`](file:///d:/code/coding-harness/src/config.ts): Configuration (`apiKey`, `model`, `systemPrompt`, provider routing).
- [`src/recorder.ts`](file:///d:/code/coding-harness/src/recorder.ts): Automatic session persistence to the `test/` folder.
- [`src/tools/`](file:///d:/code/coding-harness/src/tools/): Modular tool architecture.
  - [`src/tools/types.ts`](file:///d:/code/coding-harness/src/tools/types.ts): Standard `Tool` interface.
  - [`src/tools/bash.ts`](file:///d:/code/coding-harness/src/tools/bash.ts): Shell execution tool (`bash`), capturing stdout + stderr.
  - [`src/tools/index.ts`](file:///d:/code/coding-harness/src/tools/index.ts): Central tool registry and dispatcher.
- [`src/llm.ts`](file:///d:/code/coding-harness/src/llm.ts): Streaming `callLLM(messages, tools, onChunk)` measuring TTFT, pure generation speed, and tool-call delta accumulation.
- [`src/index.ts`](file:///d:/code/coding-harness/src/index.ts): Autonomous multi-turn agent loop executing tools, reporting metrics, and saving complete transcripts.

## Session Recording (`test/`)

Every run automatically writes a timestamped record to the [`test/`](file:///d:/code/coding-harness/test/) directory:
```
test/
└── run_2026-09-30_15-11-58.json
```
Each file captures:
- `id` & `timestamp`
- `prompt` & `model`
- `turns` taken
- `final_response`
- `usage` (prompt tokens, completion tokens, reasoning tokens, cached tokens, and cost)
- `metrics` (pure generation speed, e2e speed, TTFT, generation time)
- `transcript` (complete step-by-step history of assistant turns, tool calls, and outputs)

## Running the Agent

1. **Set your API Key** in [`.env`](file:///d:/code/coding-harness/.env):
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

2. **Interactive Prompt**:
   ```bash
   npm run dev
   # Prompts: Enter your prompt>
   ```

3. **Direct CLI Argument**:
   ```bash
   npm run dev -- "Check what git branch I am currently on."
   npm run dev -- "List all TypeScript files in the src directory."
   ```
