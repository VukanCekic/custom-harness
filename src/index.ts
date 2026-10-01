import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { saveRunResult } from "./recorder.js";
import { ui } from "./ui.js";
import { closeBrowser } from "./tools/browser.js";

import { activeForm } from "./todos.js";
import * as sandbox from "./sandbox.js";
import { compact } from "./compact.js";

async function loadLastSessionTranscript(): Promise<ChatMessages[] | null> {
  const testDir = path.resolve(process.cwd(), "test");
  try {
    const files = await fs.readdir(testDir);
    const jsonFiles = files.filter((f) => f.startsWith("run_") && f.endsWith(".json"));
    if (jsonFiles.length === 0) return null;

    jsonFiles.sort().reverse();
    const latestFile = path.join(testDir, jsonFiles[0]);
    const content = await fs.readFile(latestFile, "utf-8");
    const record = JSON.parse(content);
    return Array.isArray(record.transcript) ? record.transcript : null;
  } catch {
    return null;
  }
}

async function runSession(
  promptText: string,
  sessionMessages?: ChatMessages[],
  debug = false
): Promise<void> {
  ui.user(promptText);

  let spinner = ui.working(`${activeForm()}...`);

  try {
    const result = await runAgent(promptText, {
      messages: sessionMessages,
      // Runs autonomously until the agent completes all tool actions
      onToolCall: (toolName) => {
        spinner.stop();
        spinner = ui.working(`running ${toolName}...`);
      },
      onToolExecution: (toolName, args, toolResult) => {
        spinner.stop();
        ui.tool(toolName, args, toolResult);
        spinner = ui.working(`${activeForm()}...`);
      },
      onApprove: async (reason) => {
        spinner.stop();
        const approved = await ui.approve(reason);
        spinner = ui.working(`${activeForm()}...`);
        return approved;
      },
      onAssistantMessage: (assistantMsg) => {
        if (debug) {
          spinner.stop();
          ui.debug(assistantMsg);
          spinner = ui.working(`${activeForm()}...`);
        }
      },
      onInjection: (content) => {
        if (debug || content.includes("<system-reminder>")) {
          spinner.stop();
          ui.injection(content);
          spinner = ui.working(`${activeForm()}...`);
        }
      },
      onMessage: (content) => {
        spinner.stop();
        ui.agent(content);
        spinner = ui.working(`${activeForm()}...`);
      },
      onCompacted: (before, compactedMessages) => {
        spinner.stop();
        ui.compacted(before, compactedMessages);
        spinner = ui.working(`${activeForm()}...`);
      },
      onStepEnd: (_step, usage) => {
        if (usage) {
          spinner.stop();
          ui.usage({
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cached_tokens: usage.cached_tokens
          });
          spinner = ui.working(`${activeForm()}...`);
        }
      }
    });

    spinner.stop();

    const e2eSpeed =
      result.lastMetrics?.e2e_tokens_per_second != null
        ? `${result.lastMetrics.e2e_tokens_per_second} tokens/sec`
        : undefined;

    const generationSpeed =
      result.lastMetrics?.generation_tokens_per_second != null
        ? `${result.lastMetrics.generation_tokens_per_second} tokens/sec`
        : undefined;

    const ttft =
      result.lastMetrics?.time_to_first_token_ms != null
        ? `${result.lastMetrics.time_to_first_token_ms}ms`
        : undefined;

    const totalCostStr = `$${result.totalCost.toFixed(6)}`;

    ui.summary({
      ttft,
      generationSpeed,
      e2eSpeed,
      totalCost: totalCostStr
    });

    // Save full details (transcript, metrics, usages) to the recorder
    try {
      const savedPath = await saveRunResult({
        prompt: promptText,
        model: config.model,
        steps: result.steps,
        final_response: result.finalResponse,
        usage: result.lastUsage
          ? {
            ...result.lastUsage,
            cost: result.totalCost
          }
          : null,
        metrics: result.lastMetrics,
        transcript: result.messages
      });
      ui.note(`Saved details to: ${savedPath}`);
    } catch (err: any) {
      ui.note(`Failed to save run details to test/ folder: ${err.message}`);
    }
  } catch (err: any) {
    spinner.stop();
    ui.note(`Execution error: ${err.message || String(err)}`);
  }
}

async function main() {
  if (!config.apiKey) {
    ui.note("Error: OPENROUTER_API_KEY is not set in your .env file.");
    process.exit(1);
  }

  ui.banner(sandbox.name(), config.model);

  const args = process.argv.slice(2);
  const isResume = args.includes("--resume");
  const isDebug = args.includes("--debug");
  const promptArgs = args.filter((a) => !a.startsWith("--"));
  const cliPrompt = promptArgs.join(" ").trim();

  let sessionMessages: ChatMessages[] = [
    { role: "system", content: config.systemPrompt }
  ];

  if (isResume) {
    const resumedTranscript = await loadLastSessionTranscript();
    if (resumedTranscript && resumedTranscript.length > 0) {
      sessionMessages = resumedTranscript;
      ui.resumed(sessionMessages);
      ui.replay(sessionMessages);
    } else {
      ui.note("No past session found in test/ to resume.");
    }
  }

  try {
    if (cliPrompt) {
      await runSession(cliPrompt, sessionMessages, isDebug);
      return;
    }

    // Interactive mode: maintains conversation history across prompts
    while (true) {
      const userInput = await ui.ask();
      if (!userInput) {
        break;
      }

      if (userInput.startsWith("/")) {
        const cmd = userInput.trim().toLowerCase();
        if (cmd === "/clear" || cmd === "/new" || cmd === "/reset") {
          await closeBrowser();
          sessionMessages = [
            { role: "system", content: config.systemPrompt }
          ];
          ui.note("Session reset. Conversation history cleared and browser closed.");
          continue;
        }
        if (cmd === "/compact") {
          const before = sessionMessages.length;
          const compSpinner = ui.working("compacting transcript...");
          try {
            await compact(sessionMessages);
            compSpinner.stop();
            if (sessionMessages.length < before) {
              ui.compacted(before, sessionMessages);
            } else {
              ui.note("Transcript is not long enough to compact.");
            }
          } catch (err: any) {
            compSpinner.stop();
            ui.note(`Compaction failed: ${err.message || String(err)}`);
          }
          continue;
        }
        if (cmd === "/help") {
          ui.note(
            "Commands:\n    /clear   - Clear session history and close browser\n    /compact - Compact conversation history to free up context\n    /help    - Show available commands"
          );
          continue;
        }
      }

      await runSession(userInput, sessionMessages, isDebug);
    }
  } finally {
    await closeBrowser();
  }
}

main().catch(async (err) => {
  await closeBrowser();
  console.error("\nFatal error:", err);
  process.exit(1);
});
