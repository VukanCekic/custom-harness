# Custom Harness

A clean, extensible Node.js + TypeScript coding agent built with `@openrouter/sdk`. Features real-time streaming, tool-calling execution (with `bash`), pure model throughput tracking (tokens/second), usage cost accounting, and automatic session recording.

## Architecture

- [`src/config.ts`](file:///d:/code/coding-harness/src/config.ts): Configuration (`apiKey`, `model`, `systemPrompt`, provider routing).
- [`src/recorder.ts`](file:///d:/code/coding-harness/src/recorder.ts): Automatic session persistence to the `test/` folder.
- [`src/tools/`](file:///d:/code/coding-harness/src/tools/): Modular tool architecture.
  - [`src/tools/types.ts`](file:///d:/code/coding-harness/src/tools/types.ts): Standard `Tool` interface.
  - [`src/tools/bash.ts`](file:///d:/code/coding-harness/src/tools/bash.ts): Shell execution tool (`bash`), capturing stdout + stderr.
  - [`src/tools/readFile.ts`](file:///d:/code/coding-harness/src/tools/readFile.ts): Direct file reading tool (`read_file`).
  - [`src/tools/writeFile.ts`](file:///d:/code/coding-harness/src/tools/writeFile.ts): Direct file creation and overwriting tool (`write_file`).
  - [`src/tools/stringReplace.ts`](file:///d:/code/coding-harness/src/tools/stringReplace.ts): Targeted file modification tool (`string_replace` / `str_replace`).
  - [`src/tools/browser.ts`](file:///d:/code/coding-harness/src/tools/browser.ts): Direct browser automation via `browserclaw` (visible window by default, snapshot + ref targeting, zero npx overhead).
  - [`src/tools/index.ts`](file:///d:/code/coding-harness/src/tools/index.ts): Central tool registry and dispatcher.
- [`src/context.ts`](file:///d:/code/coding-harness/src/context.ts): Late prompt injection module providing ephemeral environment reminders (`time`, `git branch`, git file diffs, disk staleness warnings) appended at the end of requests to keep the prefix cache 100% stable.
- [`src/llm.ts`](file:///d:/code/coding-harness/src/llm.ts): Streaming `callLLM(messages, tools, onChunk)` measuring TTFT, pure generation speed, and tool-call delta accumulation.
- [`src/index.ts`](file:///d:/code/coding-harness/src/index.ts): Autonomous agent loop executing tools until task completion, reporting metrics, session resumption, and saving complete transcripts.

## Session Recording (`test/`)

Every run automatically writes a timestamped record to the [`test/`](file:///d:/code/coding-harness/test/) directory:
```
test/
└── run_2026-09-30_15-11-58.json
```
Each file captures:
- `id` & `timestamp`
- `prompt` & `model`
- `steps` (steps taken)
- `final_response`
- `usage` (prompt tokens, completion tokens, reasoning tokens, cached tokens, and cost)
- `metrics` (pure generation speed, e2e speed, TTFT, generation time)
- `transcript` (complete step-by-step history of assistant actions, tool calls, and outputs)

## Running the Agent

1. **Set your API Key** in [`.env`](file:///d:/code/coding-harness/.env):
   ```env
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

2. **Interactive Prompt**:
   ```bash
   npm run dev
   # Prompts: >
   # Commands: /clear (reset session), /help
   ```

3. **Resume Last Session**:
   ```bash
   npm run dev -- --resume
   ```

4. **Direct CLI Argument**:
   ```bash
   npm run dev -- "Check what git branch I am currently on."
   npm run dev -- "List all TypeScript files in the src directory."
   ```

5. **Debug Mode**:
   ```bash
   npm run dev -- --debug "Inspect project layout"
   ```
