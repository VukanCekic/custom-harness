import type { ChatMessages } from "@openrouter/sdk/models";
import { config } from "./config.js";
import {
  callLLM,
  type AssistantMessageResult,
  type DetailedUsage,
  type TimingMetrics
} from "./llm.js";
import { executeTool, TOOL_SCHEMAS } from "./tools/index.js";
import { reminder } from "./context.js";

export interface AgentOptions {
  messages?: ChatMessages[];
  onStepStart?: (step: number) => void;
  onStepEnd?: (step: number, usage: DetailedUsage | null) => void;
  onToolCall?: (toolName: string, args: Record<string, any>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onToolExecution?: (toolName: string, args: Record<string, any>, result: string) => void;
  onMessage?: (content: string) => void;
  onAssistantMessage?: (message: AssistantMessageResult) => void;
  onInjection?: (content: string) => void;
  onChunk?: (chunk: string) => void;
  injectReminder?: boolean;
}

export interface AgentResult {
  finalResponse: string;
  messages: ChatMessages[];
  steps: number;
  totalCost: number;
  lastUsage: DetailedUsage | null;
  lastMetrics: TimingMetrics | null;
}

/**
 * Runs the autonomous agent loop.
 * Continues calling the LLM and executing requested tools in a loop
 * until the model finishes without requesting any more tool calls.
 */
export async function runAgent(
  userInput: string,
  options: AgentOptions = {}
): Promise<AgentResult> {
  // If an existing conversation history is provided, append user prompt to it;
  // otherwise, initialize a fresh transcript with system prompt.
  const messages: ChatMessages[] = options.messages ?? [
    { role: "system", content: config.systemPrompt }
  ];

  const lastMsg = messages[messages.length - 1];
  if (userInput && (lastMsg?.role !== "user" || lastMsg?.content !== userInput)) {
    messages.push({ role: "user", content: userInput });
  }

  let step = 0;
  let totalCost = 0;
  let lastUsage: DetailedUsage | null = null;
  let lastMetrics: TimingMetrics | null = null;
  let finalResponse = "";

  while (true) {
    step++;

    if (options.onStepStart) {
      options.onStepStart(step);
    }

    // Late injection: a small dynamic block appended just before sending.
    // Appended to the very end of messages passed to callLLM so the stable prefix
    // in messages stays cached by the LLM provider.
    let lateReminder: ChatMessages | null = null;
    if (options.injectReminder !== false) {
      lateReminder = reminder();
      if (options.onInjection && typeof lateReminder.content === "string") {
        options.onInjection(lateReminder.content);
      }
    }
    const messagesToSend: ChatMessages[] =
      lateReminder ? [...messages, lateReminder] : messages;

    // Call the LLM with conversation history (+ late injection) and available tools
    const { message, usage, metrics } = await callLLM(
      messagesToSend,
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

    if (options.onAssistantMessage) {
      options.onAssistantMessage(message);
    }

    if (message.content) {
      finalResponse = message.content;
      if (options.onMessage) {
        options.onMessage(message.content);
      }
    }

    // If no tool calls were requested, the agent is done
    if (!message.toolCalls || message.toolCalls.length === 0) {
      if (options.onStepEnd) {
        options.onStepEnd(step, usage);
      }
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

    if (options.onStepEnd) {
      options.onStepEnd(step, usage);
    }
  }

  return {
    finalResponse,
    messages,
    steps: step,
    totalCost,
    lastUsage,
    lastMetrics
  };
}
