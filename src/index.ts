import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import { callLLM } from "./llm.js";
import { executeTool, TOOL_SCHEMAS } from "./tools/index.js";
import { saveRunResult } from "./recorder.js";

async function promptUser(query: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(query);
    return answer.trim();
  } finally {
    rl.close();
  }
}

const MAX_TURNS = 15;

async function main() {
  if (!config.apiKey) {
    console.error("Error: OPENROUTER_API_KEY is not set in your .env file.");
    process.exit(1);
  }

  // Support command-line argument prompt or interactive prompt
  const cliPrompt = process.argv.slice(2).join(" ").trim();
  const userInput = cliPrompt || (await promptUser("Enter your prompt> "));

  if (!userInput) {
    console.log("No prompt entered. Exiting.");
    return;
  }

  console.log(`Model: ${config.model}`);
  process.stdout.write("Working...");

  const messages: ChatMessages[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: userInput }
  ];

  let turn = 0;
  let totalCost = 0;
  let lastUsage: any = null;
  let lastMetrics: any = null;
  let finalResponse: string = "";

  while (turn < MAX_TURNS) {
    turn++;
    process.stdout.write(`\rWorking... (turn ${turn})`);

    // Do not stream intermediate tool turns to the screen
    const { message, usage, metrics } = await callLLM(messages, TOOL_SCHEMAS);

    lastUsage = usage;
    lastMetrics = metrics;
    if (usage?.cost) {
      totalCost += usage.cost;
    }

    // Check if the model requested any tool calls
    if (message.toolCalls && message.toolCalls.length > 0) {
      // Record the assistant's turn with tool calls in history
      messages.push({
        role: "assistant",
        content: message.content || "",
        toolCalls: message.toolCalls
      });

      // Execute each tool silently in the background
      for (const toolCall of message.toolCalls) {
        const toolName = toolCall.function.name;
        let args: Record<string, any> = {};

        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          // ignore parse errors, toolResult handles it
        }

        let toolResult = "";
        try {
          toolResult = await executeTool(toolName, args);
        } catch (err: any) {
          toolResult = `Tool error: ${err.message || String(err)}`;
        }

        // Save tool response in history
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: toolResult
        });
      }
    } else {
      // No more tool calls: model produced the final answer
      finalResponse = message.content || "";
      break;
    }
  }

  // Clear progress line
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  // 1. Last output
  console.log(`Agent:\n${finalResponse}\n`);

  // 2. End-to-end speed & 3. Final cost
  const e2eSpeed =
    lastMetrics?.e2e_tokens_per_second != null
      ? `${lastMetrics.e2e_tokens_per_second} tokens/sec`
      : "N/A";
  const finalCostStr = `$${totalCost.toFixed(6)}`;

  console.log("----------------------------------------");
  console.log(`End-to-End Speed: ${e2eSpeed}`);
  console.log(`Final Cost:       ${finalCostStr}`);
  console.log("----------------------------------------");

  // Save all full details (transcript, metrics, usages) to the recorder
  try {
    const savedPath = await saveRunResult({
      prompt: userInput,
      model: config.model,
      turns: turn,
      final_response: finalResponse,
      usage: {
        ...(lastUsage || {}),
        cost: totalCost
      },
      metrics: lastMetrics,
      transcript: messages
    });
    console.log(`Saved details to: ${savedPath}`);
  } catch (err: any) {
    console.error(`Failed to save run details to test/ folder: ${err.message}`);
  }
}

main().catch((err) => {
  console.error("\nExecution failed:", err);
  process.exit(1);
});
