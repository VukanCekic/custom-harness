import type { Tool } from "./types.js";
import { bashTool } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { readSkillTool } from "./readSkill.js";
import { browserTool } from "./browser.js";
import { grepTool, globTool } from "./search.js";
import { runSubagent } from "../subagent.js";
import { config } from "../config.js";

export const MAX_TURNS = config.subagentMaxTurns || 15;

/**
 * The research subagent's tools - read-only exploration. This allowlist is
 * the whole guarantee: a tool not on it is never offered, so the researcher
 * cannot recurse into `task`, touch the plan, or edit. Its run is also
 * read-only at the permission gate, so a command that would need approval
 * is refused rather than asked.
 */
export const SUBAGENT_TOOLS: Tool[] = [
  bashTool,
  readFileTool,
  grepTool,
  globTool,
  readSkillTool,
  browserTool
];

export function getSubagentSystemPrompt(): string {
  const cwd = process.cwd();
  return `You are a research subagent. Your job is to explore the codebase and answer the task question.
You only read and inspect; you never edit.
Search in batches: one grep or glob that covers several candidates beats several narrow ones.
Be concise and specific - aim for under 150 words. Cite exact file paths, line numbers, function names, and error text.
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
      label: "subagent",
      readOnly: true
    });
  }
};
