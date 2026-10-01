import fs from "node:fs/promises";
import type { Tool } from "./types.js";
import { SKILLS, reloadSkills } from "../skills.js";

export interface ReadSkillArgs {
  name: string;
}

/**
 * Tool for reading the full instructions of a skill by name.
 */
export const readSkillTool: Tool<ReadSkillArgs, string> = {
  name: "read_skill",
  schema: {
    type: "function",
    function: {
      name: "read_skill",
      description: "Open a skill by name and return its full instructions.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the skill to open"
          }
        },
        required: ["name"]
      }
    }
  },
  execute: async ({ name }: ReadSkillArgs) => {
    if (!name || typeof name !== "string") {
      return "Error: Skill name must be provided.";
    }

    const trimmedName = name.trim();
    let skill = SKILLS[trimmedName];

    // Case-insensitive fallback if exact match not found
    if (!skill) {
      const lower = trimmedName.toLowerCase();
      const match = Object.keys(SKILLS).find((k) => k.toLowerCase() === lower);
      if (match) {
        skill = SKILLS[match];
      }
    }

    // If still not found, try reloading skills in case a new skill was added
    if (!skill) {
      const freshSkills = reloadSkills();
      skill = freshSkills[trimmedName];
      if (!skill) {
        const lower = trimmedName.toLowerCase();
        const match = Object.keys(freshSkills).find((k) => k.toLowerCase() === lower);
        if (match) {
          skill = freshSkills[match];
        }
      }
    }

    if (!skill) {
      const available = Object.keys(SKILLS);
      return `Error: Skill "${trimmedName}" not found. Available skills: ${
        available.length > 0 ? available.join(", ") : "none"
      }`;
    }

    try {
      const content = await fs.readFile(skill.path, "utf-8");
      return content;
    } catch (err: any) {
      return `Error reading skill "${trimmedName}": ${err.message || String(err)}`;
    }
  }
};
