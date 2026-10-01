import type { Tool } from "./types.js";
import type { ChatFunctionTool } from "@openrouter/sdk/models";
import { bashTool } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { readSkillTool } from "./readSkill.js";
import { browserTool } from "./browser.js";
import { runSubagent } from "../subagent.js";
import { config } from "../config.js";

export const MAX_TURNS = config.subagentMaxTurns || 15;

/**
 * Structural guarantee: tools withheld from the research subagent.
 */
export const WITHHELD = new Set([
  "task",
  "write_todos",
  "str_replace",
  "string_replace",
  "write_file"
]);

/**
 * Tools structurally offered to the research subagent (read-only exploration tools).
 */
export const SUBAGENT_TOOLS: Tool[] = [
  bashTool,
  readFileTool,
  readSkillTool,
  browserTool
];

export const SUBAGENT_TOOL_SCHEMAS: ChatFunctionTool[] = SUBAGENT_TOOLS.map(
  (t) => t.schema
);

export function getSubagentSystemPrompt(): string {
  const cwd = process.cwd();
  return `You are a research subagent. Your job is to explore the codebase and answer the task question.
You only read and inspect; you never edit.
Be concise and specific. Cite exact file paths, line numbers, function names, and error text.
When your exploration is complete, summarize your findings directly. Do not call any more tools once you have the answer.

Your current working directory is: ${cwd}`;
}

export interface TaskArgs {
  description: string;
  [key: string]: any;
}

export const taskTool: Tool<TaskArgs, string> = {
  name: "task",
  schema: {
    type: "function",
    function: {
      name: "task",
      description:
        "Hand a self-contained exploration question to a fresh agent that " +
        "has its own context window, and get back its findings. Use this " +
        "to learn how the codebase works - tracing behaviour, locating " +
        "where something is implemented, surveying files - so the search " +
        "costs you one answer instead of dozens of tool results. It cannot " +
        "see this conversation, so include every detail it needs. It reads " +
        "and reports; it never edits. Do your own editing.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "The self-contained exploration question or task."
          }
        },
        required: ["description"]
      }
    }
  },
  execute: async (args) => {
    const description =
      args.description || args.prompt || args.task || args.question || JSON.stringify(args);
    return await runSubagent({
      role: "researcher",
      taskDescription: description,
      systemPrompt: getSubagentSystemPrompt(),
      allowedTools: SUBAGENT_TOOLS,
      maxTurns: MAX_TURNS,
      label: "subagent"
    });
  }
};
