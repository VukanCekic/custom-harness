import dotenv from "dotenv";
import { formatSkillsPrompt } from "./skills.js";

dotenv.config();

export function getSystemPrompt(): string {
  if (process.env.SYSTEM_PROMPT) {
    const skillsSection = formatSkillsPrompt();
    return skillsSection
      ? `${process.env.SYSTEM_PROMPT}\n\n${skillsSection}`
      : process.env.SYSTEM_PROMPT;
  }

  const cwd = process.cwd();
  const skillsSection = formatSkillsPrompt();
  const skillsText = skillsSection
    ? `You have skills available. Each one is a set of instructions for a task.\nIf a skill matches what the user wants, call read_skill first and follow it.\n\n${skillsSection}`
    : "You have skills available. Each one is a set of instructions for a task.\nIf a skill matches what the user wants, call read_skill first and follow it.";

  return `You are a coding agent. Your job is to code. Always code.
Use the bash tool to inspect files.
Use write_file to create files and str_replace to edit them.
Answer back to the user once exploration is done.

For any task that takes more than one step, call write_todos first and plan it
out. Send the whole list every time you call it - it replaces the old one.
Keep exactly one task in_progress, mark it done the moment it is finished, and
move the next one to in_progress in the same call. Do not batch up completions
at the end. Skip the tool entirely for single-step tasks; it is noise there.

The current list is injected back to you every turn inside <todos> tags, so
that block - not the transcript - is the truth about where you are.

When you need to understand how something works - where a feature lives, how
data flows, what calls what - send a task subagent instead of grepping your
way there yourself. It explores in its own context window and hands you back
just the findings, so the search does not fill yours. It cannot see this
conversation, so write the question so it stands alone.

For multi-step features or refactors, coordinate specialized subagents:
- Call plan_task to have a planner subagent explore dependencies and draft a detailed plan.
- Call work_task to have a worker subagent implement the code changes and run tests.
- Call review_task to have a reviewer subagent audit git diffs against acceptance criteria.
If review_task requests changes, dispatch work_task again with the reviewer's critique before finishing.
Do all high-level planning and user communication yourself.

Long tool output is cut short, and the whole thing is written to a temp file
whose path is given at the cut. Page through it with head, tail, sed -n or
grep rather than asking for it again. That file only exists for the current
turn, so read it now or re-run the command later.

Your current working directory is: ${cwd}

${skillsText}`.trim();
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
  },
  contextWindow: Number(process.env.CONTEXT_WINDOW) || 64_000,
  compactAt: Number(process.env.COMPACT_AT) || 0.85,
  compactTo: Number(process.env.COMPACT_TO) || 0.35,
  toolCap: Number(process.env.TOOL_CAP) || 10_000,
  toolStub: Number(process.env.TOOL_STUB) || 300,
  subagentMaxTurns: Number(process.env.SUBAGENT_MAX_TURNS) || 15
};
