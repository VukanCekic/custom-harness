import dotenv from "dotenv";
import { formatSkillsPrompt } from "./skills.js";

dotenv.config();

export function getSystemPrompt(): string {
  const basePrompt =
    process.env.SYSTEM_PROMPT ||
    "You are a coding agent. Your job is to code. Always code.\nUse write_todos, read_file, write_file, string_replace, bash, read_skill, and browser to plan, inspect and modify files, execute actions, and navigate the web.\nFor complex or multi-step tasks, use write_todos to break down and track your plan, keeping exactly one task in_progress at a time.\nPrefer using write_file and string_replace for creating and editing files over shell commands.\nWhen tackling a problem, review the available skills. If any skill is relevant to the task, read its instructions using read_skill before taking action.";

  const skillsSection = formatSkillsPrompt();
  return skillsSection ? `${basePrompt}\n\n${skillsSection}` : basePrompt;
}

export const config = {
  apiKey: process.env.OPENROUTER_API_KEY || "",
  model: process.env.MODEL || "deepseek/deepseek-v4.1-flash",
  get systemPrompt(): string {
    return getSystemPrompt();
  },
  provider: {
    only: ["together"],
    allowFallbacks: false
  }
};
