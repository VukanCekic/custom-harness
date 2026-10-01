import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export const SKILL_DIRS = [
  path.join(process.cwd(), ".agents", "skills"),
  path.join(os.homedir(), ".agents", "skills")
];

/**
 * Scan SKILL_DIRS for any skill directories containing a SKILL.md file.
 * Maps each skill name to its description and SKILL.md path.
 */
export function findSkills(): Record<string, SkillInfo> {
  const skills: Record<string, SkillInfo> = {};

  for (const directory of SKILL_DIRS) {
    if (!fs.existsSync(directory)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      const subdirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const subdir of subdirs) {
        const skillPath = path.join(directory, subdir, "SKILL.md");
        if (!fs.existsSync(skillPath)) {
          continue;
        }

        try {
          const content = fs.readFileSync(skillPath, "utf-8");
          const parts = content.split("---");

          if (parts.length >= 3) {
            const frontmatter = parts[1];
            const meta = yaml.parse(frontmatter) || {};
            const skillName = meta.name || subdir;
            const description = meta.description
              ? meta.description.trim().replace(/\s+/g, " ")
              : "";

            // First directory in SKILL_DIRS (cwd) takes priority over subsequent ones
            if (!skills[skillName]) {
              skills[skillName] = {
                name: skillName,
                description,
                path: skillPath
              };
            }
          }
        } catch (err) {
          // If a specific SKILL.md fails to parse, skip it gracefully
          console.error(`Warning: Failed to parse skill at ${skillPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`Warning: Failed to read skill directory ${directory}:`, err);
    }
  }

  return skills;
}

/**
 * Static registry of discovered skills loaded at startup.
 */
export let SKILLS: Record<string, SkillInfo> = findSkills();

/**
 * Reloads skills from disk.
 */
export function reloadSkills(): Record<string, SkillInfo> {
  SKILLS = findSkills();
  return SKILLS;
}

/**
 * Formats the list of available skills with names and descriptions
 * for inclusion in the agent's system prompt.
 */
export function formatSkillsPrompt(skills: Record<string, SkillInfo> = SKILLS): string {
  const list = Object.values(skills).sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) {
    return "";
  }

  const lines = [
    "## Available Skills",
    "You have access to specialized skills. If any skill is relevant to the user request, use the read_skill tool to consult its full instructions before proceeding:",
    ...list.map((s) => `- ${s.name}: ${s.description}`)
  ];

  return lines.join("\n");
}
