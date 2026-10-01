import type { Tool } from "./tools/types.js";
import type { ChatFunctionTool, ChatMessages } from "@openrouter/sdk/models";
import { callLLM } from "./llm.js";
import { cap, sweep } from "./history.js";
import { ui } from "./ui.js";
import { config } from "./config.js";

export type SubagentRole = "planner" | "worker" | "reviewer" | "researcher";

export interface SubagentConfig {
  role: SubagentRole;
  taskDescription: string;
  systemPrompt: string;
  allowedTools: Tool[];
  maxTurns?: number;
  label?: string;
}

/**
 * Universal subagent runner with an isolated context window.
 *
 * Rules:
 * 1. "Nothing goes in": Starts with exactly two messages (role system prompt + task description).
 * 2. "Only the answer comes back": Internal tool calls/results are private; only the final text is returned.
 * 3. "Structural tool withholding": Offered only the tools explicitly permitted in `config.allowedTools`.
 * 4. Context protection: Tool results are capped inline; temp files are cleaned up on exit.
 */
export async function runSubagent(subagentConfig: SubagentConfig): Promise<string> {
  const {
    role,
    taskDescription,
    systemPrompt,
    allowedTools,
    maxTurns = config.subagentMaxTurns || 15,
    label = role
  } = subagentConfig;

  const toolMap: Record<string, Tool> = Object.fromEntries(
    allowedTools.map((t) => [t.name, t])
  );
  const toolSchemas: ChatFunctionTool[] = allowedTools.map((t) => t.schema);

  const messages: ChatMessages[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: taskDescription }
  ];

  let report = "";
  let spinner = ui.working(`${label} working...`);

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      spinner.stop();
      spinner = ui.working(`${label} working (turn ${turn}/${maxTurns})...`);

      const { message, usage } = await callLLM(messages, toolSchemas);

      if (usage) {
        ui.usage({
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          cached_tokens: usage.cached_tokens
        });
      }

      messages.push({
        role: "assistant",
        content: message.content || "",
        toolCalls: message.toolCalls
      });

      if (message.content) {
        report = message.content;
      }

      // Subagent finished if no tool calls requested
      if (!message.toolCalls || message.toolCalls.length === 0) {
        spinner.stop();
        return report || `${label} completed with no output.`;
      }

      // Execute requested tools
      for (const toolCall of message.toolCalls) {
        const toolName = toolCall.function.name;
        let args: Record<string, any> = {};

        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          // Keep args empty on malformed JSON
        }

        const tool = toolMap[toolName];
        if (!tool) {
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: `Permission denied: Tool "${toolName}" is not available to the ${role} subagent.`
          });
          continue;
        }

        spinner.stop();
        spinner = ui.working(`${label}: running ${toolName}...`);

        let result = "";
        try {
          const raw = await tool.execute(args);
          result = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
        } catch (err: any) {
          result = `Tool error: ${err.message || String(err)}`;
        }

        // Inline output cap
        const capped = cap(result);

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: capped
        });
      }
    }

    spinner.stop();

    if (report) {
      return `(stopped after ${maxTurns} turns, before finishing. Partial findings below - narrow the question and ask again.)\n\n${report}`;
    }
    return `(stopped after ${maxTurns} turns with nothing to report.)`;
  } finally {
    spinner.stop();
    sweep();
  }
}
