import type { ChatFunctionTool } from "@openrouter/sdk/models";
import type { Tool } from "./types.js";
import type { Mode } from "../config.js";
import { taskTool } from "./task.js";
import { planTool, workTool, reviewTool } from "./orchestrator.js";
import { bashTool } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { stringReplaceTool } from "./stringReplace.js";
import { writeTodosTool } from "./writeTodos.js";
import { readSkillTool } from "./readSkill.js";
import { browserTool } from "./browser.js";
import { grepTool, globTool } from "./search.js";
import { askUserTool } from "./askUser.js";

/**
 * All active tools available to the LLM agent.
 * To add a new tool in the future, simply define it and add it to this list.
 */
export const registeredTools: Tool[] = [
  planTool,
  workTool,
  reviewTool,
  taskTool,
  bashTool,
  readFileTool,
  grepTool,
  globTool,
  writeFileTool,
  stringReplaceTool,
  writeTodosTool,
  readSkillTool,
  askUserTool,
  browserTool
];

/**
 * Pipeline mode: the main agent coordinates and talks to the user, and every
 * change is made by a worker. Its bash is read-only (see agent.ts).
 */
export const PIPELINE_TOOLS: Tool[] = [
  planTool,
  workTool,
  reviewTool,
  taskTool,
  writeTodosTool,
  bashTool,
  readSkillTool,
  askUserTool
];

export const TOOL_SCHEMAS: ChatFunctionTool[] = registeredTools.map((t) => t.schema);
const PIPELINE_SCHEMAS: ChatFunctionTool[] = PIPELINE_TOOLS.map((t) => t.schema);

export const TOOLS_BY_NAME: Record<string, Tool> = {
  ...Object.fromEntries(registeredTools.map((t) => [t.name, t])),
  str_replace: stringReplaceTool,
  string_replace: stringReplaceTool
};

const PIPELINE_BY_NAME: Record<string, Tool> = Object.fromEntries(PIPELINE_TOOLS.map((t) => [t.name, t]));

/** The tools the main agent is offered in a mode, as schemas and by name. */
export function toolsFor(mode: Mode): { schemas: ChatFunctionTool[]; byName: Record<string, Tool> } {
  return mode === "pipeline"
    ? { schemas: PIPELINE_SCHEMAS, byName: PIPELINE_BY_NAME }
    : { schemas: TOOL_SCHEMAS, byName: TOOLS_BY_NAME };
}

/**
 * Dispatches and executes a tool by name with provided arguments.
 * No permission check - for tests and scripts, not for model output.
 */
export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) {
    throw new Error(`Tool "${name}" is not registered.`);
  }

  const result = await tool.execute(args);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export * from "./types.js";
export * from "./bash.js";
export * from "./readFile.js";
export * from "./writeFile.js";
export * from "./stringReplace.js";
export * from "./writeTodos.js";
export * from "./readSkill.js";
export * from "./browser.js";
export * from "./search.js";
export * from "./askUser.js";
export * from "./task.js";
export * from "./orchestrator.js";
