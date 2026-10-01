import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { saveRunResult } from "./recorder.js";
import { ui } from "./ui.js";

async function runSession(promptText: string): Promise<void> {
  ui.user(promptText);

  let spinner = ui.working("thinking...");

  try {
    const result = await runAgent(promptText, {
      maxTurns: 50,
      onTurnStart: (turn) => {
        spinner.stop();
        spinner = ui.working(`thinking (turn ${turn})...`);
      },
      onToolCall: (toolName) => {
        spinner.stop();
        spinner = ui.working(`running ${toolName}...`);
      },
      onToolExecution: (toolName, args, toolResult) => {
        spinner.stop();
        ui.tool(toolName, args, toolResult);
        spinner = ui.working("thinking...");
      },
      onTurnEnd: (_turn, usage) => {
        if (usage) {
          ui.usage({
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cached_tokens: usage.cached_tokens
          });
        }
      }
    });

    spinner.stop();

    if (result.finalResponse) {
      ui.agent(result.finalResponse);
    }

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
        turns: result.turns,
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

  ui.banner(process.env.SANDBOX || "local", config.model);

  // Support command-line argument prompt or interactive prompt loop
  const cliPrompt = process.argv.slice(2).join(" ").trim();

  if (cliPrompt) {
    await runSession(cliPrompt);
    return;
  }

  // Interactive mode
  while (true) {
    const userInput = await ui.ask();
    if (!userInput) {
      break;
    }
    await runSession(userInput);
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
