import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import { callLLM, type DetailedUsage, type TimingMetrics } from "./llm.js";
import { executeTool, TOOL_SCHEMAS } from "./tools/index.js";

export interface AgentOptions {
  maxTurns?: number;
  onTurnStart?: (turn: number) => void;
  onTurnEnd?: (turn: number, usage: DetailedUsage | null) => void;
  onToolCall?: (toolName: string, args: Record<string, any>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onToolExecution?: (toolName: string, args: Record<string, any>, result: string) => void;
  onChunk?: (chunk: string) => void;
}

export interface AgentResult {
  finalResponse: string;
  messages: ChatMessages[];
  turns: number;
  totalCost: number;
  lastUsage: DetailedUsage | null;
  lastMetrics: TimingMetrics | null;
}

/**
 * Runs the agentic loop.
 * Continues sending messages and executing requested tools in a while loop
 * until the model finishes without requesting any more tool calls.
 */
export async function runAgent(
  userInput: string,
  options: AgentOptions = {}
): Promise<AgentResult> {
  const maxTurns = options.maxTurns ?? 15;

  const messages: ChatMessages[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: userInput }
  ];

  let turn = 0;
  let totalCost = 0;
  let lastUsage: DetailedUsage | null = null;
  let lastMetrics: TimingMetrics | null = null;
  let finalResponse = "";

  while (true) {
    turn++;
    if (turn > maxTurns) {
      break;
    }

    if (options.onTurnStart) {
      options.onTurnStart(turn);
    }

    // Call the LLM with current conversation history and available tools
    const { message, usage, metrics } = await callLLM(
      messages,
      TOOL_SCHEMAS,
      options.onChunk
    );

    lastUsage = usage;
    lastMetrics = metrics;
    if (usage?.cost) {
      totalCost += usage.cost;
    }

    // Record the assistant's response in history
    messages.push({
      role: "assistant",
      content: message.content || "",
      toolCalls: message.toolCalls
    });

    // If no tool calls were requested, the agent is done
    if (!message.toolCalls || message.toolCalls.length === 0) {
      finalResponse = message.content || "";
      break;
    }

    // Execute each tool call requested by the model
    for (const toolCall of message.toolCalls) {
      const toolName = toolCall.function.name;
      let args: Record<string, any> = {};

      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        // Keep args empty on malformed JSON
      }

      if (options.onToolCall) {
        options.onToolCall(toolName, args);
      }

      let result = "";
      try {
        result = await executeTool(toolName, args);
      } catch (err: any) {
        result = `Tool error: ${err.message || String(err)}`;
      }

      if (options.onToolResult) {
        options.onToolResult(toolName, result);
      }

      if (options.onToolExecution) {
        options.onToolExecution(toolName, args, result);
      }

      // Add tool output back into conversation history
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: result
      });
    }

    if (options.onTurnEnd) {
      options.onTurnEnd(turn, usage);
    }
  }

  return {
    finalResponse,
    messages,
    turns: turn,
    totalCost,
    lastUsage,
    lastMetrics
  };
}
