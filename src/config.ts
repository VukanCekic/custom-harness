import dotenv from "dotenv";
import { formatSkillsPrompt } from "./skills.js";

dotenv.config();

export function getSystemPrompt(): string {
  const basePrompt =
    process.env.SYSTEM_PROMPT ||
    "You are a coding agent. Your job is to code. Always code.\nUse the bash tool, read_file, read_skill, and browser to inspect files, navigate the web, and execute actions.\nWhen tackling a problem, review the available skills. If any skill is relevant to the task, read its instructions using read_skill before taking action.";

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
