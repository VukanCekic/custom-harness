import dotenv from "dotenv";
import { formatSkillsPrompt } from "./skills.js";

dotenv.config({ quiet: true });

/**
 * "default": the agent codes, and may run the pipeline for big jobs.
 * "pipeline": the agent only coordinates subagents (/pipeline, --pipeline).
 */
export type Mode = "default" | "pipeline";

const maxRework = Number(process.env.MAX_REWORK) || 2;

const PIPELINE_STEPS = `1. plan_task - a planner subagent explores the code and writes a plan with
   acceptance criteria. The plan is saved and you get back its plan_id.
2. work_task with that plan_id - a worker subagent implements it and runs the tests.
3. review_task with the same plan_id - a reviewer subagent checks every change
   (new files included) against the plan and returns a structured verdict.
If the verdict is changes_requested, call work_task again with the same plan_id
and the reviewer's issues as instructions. The harness allows ${maxRework} rework
cycle(s) per plan; after that, stop and report the open issues to the user.
Pass plans by plan_id - never paste a plan into work_task yourself.`;

export function getSystemPrompt(mode: Mode = "default"): string {
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

  const role =
    mode === "pipeline"
      ? `You are a coding agent running in pipeline mode. You coordinate subagents
and talk to the user; you do not edit files yourself, and your bash is
read-only. Every change is made by a worker subagent:

${PIPELINE_STEPS}

Do the high-level planning and all communication with the user yourself.`
      : `You are a coding agent. You make the changes yourself: look around with
grep, glob and bash, read files with read_file, create files with write_file
and edit them with str_replace. Answer the user once the work is done. If
something essential is ambiguous, ask with ask_user instead of guessing.

For a large multi-file feature or refactor - or whenever the user asks for
the pipeline - coordinate subagents instead of editing yourself:
${PIPELINE_STEPS}
Once you call plan_task, the harness limits you to the coordination tools and
read-only bash for the rest of the turn.`;

  return `${role}

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

Long tool output is cut short, and the whole thing is written to a temp file
whose path is given at the cut. Page through it with read_file (offset and
limit) or grep rather than asking for it again. That file only exists for the
current turn, so read it now or re-run the command later.

Your current working directory is: ${cwd}

${skillsText}`.trim();
}

const list = (value: string | undefined, fallback: string[]): string[] =>
  value ? value.split(",").map((v) => v.trim()).filter(Boolean) : fallback;

export const config = {
  apiKey: process.env.OPENROUTER_API_KEY || "",
  model: process.env.MODEL || "deepseek/deepseek-v4.1-flash",
  get systemPrompt(): string {
    return getSystemPrompt();
  },
  // Routing used to be pinned to Together with fallbacks off, so any MODEL
  // Together does not serve (every Anthropic model, for one) could not run.
  // PROVIDER_ONLY="together" restores the old behaviour.
  provider: process.env.PROVIDER_ONLY
    ? { only: process.env.PROVIDER_ONLY.split(",").map((p) => p.trim()), allowFallbacks: false }
    : undefined,
  contextWindow: Number(process.env.CONTEXT_WINDOW) || 64_000,
  compactAt: Number(process.env.COMPACT_AT) || 0.85,
  compactTo: Number(process.env.COMPACT_TO) || 0.35,
  // Stripping a finished turn costs one re-prefill of it. Below this share of
  // the window that costs more than the tokens it saves, so results stay whole.
  stripAfter: Number(process.env.STRIP_AFTER ?? 0.25),
  toolCap: Number(process.env.TOOL_CAP) || 10_000,
  toolStub: Number(process.env.TOOL_STUB) || 300,
  subagentMaxTurns: Number(process.env.SUBAGENT_MAX_TURNS) || 15,
  subagentTimeoutMs: Number(process.env.SUBAGENT_TIMEOUT_MS) || 600_000,
  maxSteps: Number(process.env.MAX_STEPS) || 60,
  // Auto-approve everything that would ask. Hard-deny rules still apply.
  bypassPermissions: ["1", "true", "yes"].includes((process.env.BYPASS_PERMISSIONS || "").toLowerCase()),
  maxRework,
  // Send providers' thinking blocks back during tool loops (some require it).
  reasoningRoundTrip: process.env.REASONING_ROUNDTRIP !== "0",
  // browser `open` needs approval for any host not on this list.
  browserAllowHosts: list(process.env.BROWSER_ALLOW_HOSTS, ["localhost", "127.0.0.1", "[::1]"]),
  // Session logs live here, never inside the project being worked on.
  sessionDir: process.env.SESSION_DIR || ""
};
