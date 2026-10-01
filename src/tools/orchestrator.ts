import type { Tool } from "./types.js";
import { bashTool } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { stringReplaceTool } from "./stringReplace.js";
import { readSkillTool } from "./readSkill.js";
import { browserTool } from "./browser.js";
import { runSubagent } from "../subagent.js";
import { config } from "../config.js";

// --- 1. Planner -------------------------------------------------------------

export function getPlannerPrompt(): string {
  const cwd = process.cwd();
  return `You are a software architect and planning subagent. Your job is to research the codebase and produce a crisp, actionable implementation plan.
You only read and inspect; you never edit or mutate files.

Your output must contain:
1. Goal & Requirements
2. Files to Modify or Create (exact paths and function names)
3. Step-by-Step Implementation Strategy
4. Verification & Testing Steps (exact test commands)
5. Acceptance Criteria

Be specific. Cite exact paths, line numbers, and existing patterns in the project. Do not make code edits.

Your current working directory is: ${cwd}`;
}

const PLANNER_TOOLS: Tool[] = [bashTool, readFileTool, readSkillTool, browserTool];

export interface PlanTaskArgs {
  goal: string;
  context?: string;
  [key: string]: any;
}

export const planTool: Tool<PlanTaskArgs, string> = {
  name: "plan_task",
  schema: {
    type: "function",
    function: {
      name: "plan_task",
      description:
        "Dispatch an isolated Planner subagent to survey the codebase, trace dependencies, " +
        "and produce a concrete, step-by-step implementation plan with acceptance criteria.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The feature, bugfix, or refactoring goal to plan out."
          },
          context: {
            type: "string",
            description: "Optional background or constraints from the user conversation."
          }
        },
        required: ["goal"]
      }
    }
  },
  execute: async (args) => {
    const goal = args.goal || args.description || JSON.stringify(args);
    const context = args.context ? `\n\nAdditional Context:\n${args.context}` : "";
    return await runSubagent({
      role: "planner",
      taskDescription: `Create an implementation plan for the following goal:\n${goal}${context}`,
      systemPrompt: getPlannerPrompt(),
      allowedTools: PLANNER_TOOLS,
      maxTurns: 10,
      label: "planner"
    });
  }
};

// --- 2. Worker --------------------------------------------------------------

export function getWorkerPrompt(): string {
  const cwd = process.cwd();
  return `You are a software engineering worker subagent. Your job is to execute the implementation plan cleanly and surgically.
Use write_file to create new files and str_replace to edit existing files.
Use bash to run builds, linters, and tests to verify your changes.

Rules:
- Adhere strictly to the provided plan.
- Make minimal, focused edits. Preserve existing coding conventions, comments, and types.
- Always run build/tests after making changes to verify correctness.
- When finished, summarize:
  * Files created or modified
  * Test & build results
  * Any deviations from the plan or open items

Your current working directory is: ${cwd}`;
}

const WORKER_TOOLS: Tool[] = [
  writeFileTool,
  stringReplaceTool,
  readFileTool,
  bashTool,
  readSkillTool
];

export interface WorkTaskArgs {
  plan: string;
  instructions?: string;
  [key: string]: any;
}

export const workTool: Tool<WorkTaskArgs, string> = {
  name: "work_task",
  schema: {
    type: "function",
    function: {
      name: "work_task",
      description:
        "Dispatch an isolated Worker subagent to implement code changes according to a plan. " +
        "The worker creates/edits files, runs builds/tests, and reports results.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description: "The implementation plan and acceptance criteria to execute."
          },
          instructions: {
            type: "string",
            description: "Optional specific instructions or previous reviewer feedback to address."
          }
        },
        required: ["plan"]
      }
    }
  },
  execute: async (args) => {
    const plan = args.plan || args.goal || JSON.stringify(args);
    const instructions = args.instructions ? `\n\nSpecific Instructions / Critique:\n${args.instructions}` : "";
    return await runSubagent({
      role: "worker",
      taskDescription: `Execute the following plan:\n${plan}${instructions}`,
      systemPrompt: getWorkerPrompt(),
      allowedTools: WORKER_TOOLS,
      maxTurns: 20,
      label: "worker"
    });
  }
};

// --- 3. Reviewer ------------------------------------------------------------

export function getReviewerPrompt(): string {
  const cwd = process.cwd();
  return `You are a rigorous code reviewer subagent. Your job is to audit recent changes against the goal and acceptance criteria.
You only read and inspect; you never edit files.
Use bash to run git diff, test commands, or linters.

Your final report MUST start with one of these exact verdict lines:
VERDICT: APPROVED
or
VERDICT: CHANGES_REQUESTED

Followed by:
- Diff Analysis: summary of changes inspected via git diff
- Verification: results of tests/builds run
- Critique & Remedies: specific file paths, lines, and fixes for any defects found

Your current working directory is: ${cwd}`;
}

const REVIEWER_TOOLS: Tool[] = [bashTool, readFileTool, readSkillTool];

export interface ReviewTaskArgs {
  goal: string;
  acceptance_criteria?: string;
  [key: string]: any;
}

export const reviewTool: Tool<ReviewTaskArgs, string> = {
  name: "review_task",
  schema: {
    type: "function",
    function: {
      name: "review_task",
      description:
        "Dispatch an isolated Reviewer subagent to audit recent git diffs and test results " +
        "against acceptance criteria. Returns VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED with detailed critique.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The intended task or feature goal to verify."
          },
          acceptance_criteria: {
            type: "string",
            description: "Optional list of requirements or test expectations to check."
          }
        },
        required: ["goal"]
      }
    }
  },
  execute: async (args) => {
    const goal = args.goal || JSON.stringify(args);
    const criteria = args.acceptance_criteria
      ? `\n\nAcceptance Criteria:\n${args.acceptance_criteria}`
      : "";
    return await runSubagent({
      role: "reviewer",
      taskDescription: `Review the codebase changes for the following goal:\n${goal}${criteria}`,
      systemPrompt: getReviewerPrompt(),
      allowedTools: REVIEWER_TOOLS,
      maxTurns: 8,
      label: "reviewer"
    });
  }
};
