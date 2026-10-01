import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import { bashTool } from "./bash.js";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { stringReplaceTool } from "./stringReplace.js";
import { readSkillTool } from "./readSkill.js";
import { grepTool, globTool } from "./search.js";
import { runSubagent } from "../subagent.js";
import { git, snapshot } from "../git.js";
import {
  artifactsDir,
  getPlan,
  knownPlans,
  parseReview,
  renderIssues,
  renderReview,
  reworksLeft,
  savePlan,
  type PlanRecord,
  type Review
} from "../pipeline.js";
import { config } from "../config.js";

function missingPlan(id?: string): string {
  const known = knownPlans();
  return (
    `Error: no plan ${id ? `"${id}"` : "yet"}. ` +
    (known.length > 0 ? `Known plans: ${known.join(", ")}. ` : "") +
    "Call plan_task first, or pass the plan text as `plan`."
  );
}

/** A plan_id, or plan text to store - whichever the model passed. */
function resolvePlan(args: { plan_id?: string; plan?: string }): PlanRecord | string {
  if (args.plan_id) return getPlan(args.plan_id) ?? missingPlan(args.plan_id);
  if (typeof args.plan === "string" && args.plan.trim()) return savePlan(args.plan);
  return getPlan() ?? missingPlan();
}

// --- 1. Planner -------------------------------------------------------------

export function getPlannerPrompt(): string {
  const cwd = process.cwd();
  return `You are a software architect and planning subagent. Your job is to research the codebase and produce a crisp, actionable implementation plan.
You only read and inspect; you never edit or mutate files.

Your output must contain:
1. Goal & Requirements - including every constraint the task states, word for word
2. Files to Modify or Create (exact paths and function names)
3. Step-by-Step Implementation Strategy
4. Verification & Testing Steps (exact test commands)
5. Acceptance Criteria

Be specific. Cite exact paths, line numbers, and existing patterns in the project. Do not make code edits.
Your final message is saved as the plan the worker follows, so write it as the plan itself - no preamble.

Your current working directory is: ${cwd}`;
}

// The browser is withheld: a planner reads the project, and an ungated
// browser could open any URL or run any script on its behalf.
const PLANNER_TOOLS: Tool[] = [bashTool, readFileTool, grepTool, globTool, readSkillTool];

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
        "and produce a concrete, step-by-step implementation plan with acceptance criteria. " +
        "The plan is saved; the result gives its plan_id for work_task and review_task.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The feature, bugfix, or refactoring goal to plan out. Quote the user's constraints exactly."
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
    const report = await runSubagent({
      role: "planner",
      taskDescription: `Create an implementation plan for the following goal:\n${goal}${context}`,
      systemPrompt: getPlannerPrompt(),
      allowedTools: PLANNER_TOOLS,
      maxTurns: 10,
      label: "planner",
      readOnly: true
    });
    if (report.startsWith("(planner ")) {
      return report; // failed or cancelled - nothing worth storing as a plan
    }
    const record = savePlan(`# Goal\n${goal}${context}\n\n${report}`);
    return (
      `Plan saved as plan_id "${record.id}" (${path.relative(process.cwd(), record.path)}). ` +
      "Pass this plan_id to work_task and review_task - do not copy the plan into their arguments.\n\n" +
      report
    );
  }
};

// --- 2. Worker --------------------------------------------------------------

export function getWorkerPrompt(): string {
  const cwd = process.cwd();
  return `You are a software engineering worker subagent. Your job is to execute the implementation plan cleanly and surgically.
Use write_file to create new files and str_replace to edit existing files.
Use bash to run builds, linters, and tests to verify your changes.

Rules:
- Adhere strictly to the provided plan, and above all to the constraints in its Goal section.
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
  grepTool,
  globTool,
  bashTool,
  readSkillTool
];

export interface WorkTaskArgs {
  plan_id?: string;
  plan?: string;
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
        "Dispatch an isolated Worker subagent to implement a stored plan. The worker creates/edits files, " +
        "runs builds/tests, and reports results. After a changes_requested review, call it again with the " +
        "same plan_id: the reviewer's issues are passed on automatically, and the number of rework cycles is limited.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "The plan_id returned by plan_task. Defaults to the newest plan."
          },
          plan: {
            type: "string",
            description: "Only when there is no plan_task plan: the plan text to execute. It is stored and given a plan_id."
          },
          instructions: {
            type: "string",
            description: "Optional extra instructions for this run."
          }
        }
      }
    }
  },
  execute: async (args) => {
    const record = resolvePlan(args);
    if (typeof record === "string") return record;

    const review = record.lastReview;
    let rework = "";
    if (review?.verdict === "changes_requested") {
      if (reworksLeft(record) === 0) {
        return (
          `Rework limit reached for ${record.id}: ${config.maxRework} cycle(s) already spent. ` +
          "Do not dispatch the worker again - report these open issues to the user:\n" +
          renderIssues(review.issues)
        );
      }
      record.reworks++;
      rework = `\n\nThe reviewer requested changes (rework ${record.reworks} of ${config.maxRework}). Fix these:\n${renderIssues(review.issues)}`;
      record.lastReview = undefined;
    }

    // The reviewer diffs against this, so it sees every change the worker
    // makes - new files included. Taken once per plan: reworks add to it.
    if (record.baseline === undefined) {
      record.baseline = await snapshot();
    }

    const instructions = args.instructions ? `\n\nSpecific Instructions:\n${args.instructions}` : "";
    return await runSubagent({
      role: "worker",
      taskDescription: `Execute the following plan (${record.id}):\n${record.text}${rework}${instructions}`,
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
Use bash to run the diff command you are given, test commands, or linters.

Check, in this order:
- Constraints: every constraint in the Goal is respected (e.g. directories that must not be touched).
- Acceptance criteria: each one is met, verified by running the tests rather than by reading alone.
- Defects: bugs, regressions and missing edge cases in the changed code.

Finish by calling submit_review exactly once:
- verdict "approved" when the criteria are met and nothing blocking is left, or
- verdict "changes_requested" with one issue per defect: file, line, problem, fix.
Keep the summary to a few sentences. Do not write the verdict as text - only submit_review counts.

Your current working directory is: ${cwd}`;
}

const REVIEWER_TOOLS: Tool[] = [bashTool, readFileTool, grepTool, globTool, readSkillTool];

/** One reviewer run's verdict box. The tool exists only inside that run. */
function submitReviewTool(box: { review?: Review }): Tool {
  return {
    name: "submit_review",
    schema: {
      type: "function",
      function: {
        name: "submit_review",
        description: "Record your verdict. Call it exactly once, as your last action.",
        parameters: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["approved", "changes_requested"] },
            summary: { type: "string", description: "A few sentences: what you checked and what you found." },
            issues: {
              type: "array",
              description: "One entry per defect. Required when changes are requested.",
              items: {
                type: "object",
                properties: {
                  file: { type: "string" },
                  line: { type: "number" },
                  problem: { type: "string" },
                  fix: { type: "string" }
                },
                required: ["problem"]
              }
            }
          },
          required: ["verdict", "summary"]
        }
      }
    },
    execute: async (args: Record<string, any>) => {
      const parsed = parseReview(args);
      if (typeof parsed === "string") return parsed;
      box.review = parsed;
      return `Review recorded: ${parsed.verdict}.`;
    }
  };
}

/** What changed since the worker started, written where the reviewer can page through it. */
async function changes(record: PlanRecord | null): Promise<string> {
  const base =
    record?.baseline ??
    ((await git(["rev-parse", "-q", "--verify", "HEAD^{tree}"])).trim() || null);
  const now = await snapshot();
  if (!base || !now) {
    return "No git baseline is available (not a git repository). Use the worker's list of files and read them directly.";
  }
  if (base === now) {
    return "The working tree is identical to the baseline: nothing has changed.";
  }
  const stat = (await git(["diff", "--stat", base, now])).trimEnd();
  const diff = await git(["diff", base, now]);
  const file = path.join(artifactsDir(), `diff-${record?.id ?? "latest"}.patch`);
  fs.writeFileSync(file, diff, "utf-8");
  const origin = record?.baseline ? "before the worker started" : "the last commit";
  return (
    `Changes since ${origin} (new and untracked files included):\n${stat}\n\n` +
    `The full diff is in ${path.relative(process.cwd(), file)} (read_file pages through it), ` +
    `or run: git diff ${base} ${now}\n` +
    "Plain `git diff` does not show new files - use one of these instead."
  );
}

export interface ReviewTaskArgs {
  plan_id?: string;
  goal?: string;
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
        "Dispatch an isolated Reviewer subagent to audit every change made since the worker started " +
        "(new files included) against the plan's acceptance criteria. Returns a structured verdict: " +
        "VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED with a list of issues.",
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "The plan_id to review against. Defaults to the newest plan."
          },
          goal: {
            type: "string",
            description: "Only when there is no stored plan: the goal to verify."
          },
          acceptance_criteria: {
            type: "string",
            description: "Optional extra requirements or test expectations to check."
          }
        }
      }
    }
  },
  execute: async (args) => {
    const record = args.plan_id ? getPlan(args.plan_id) : args.goal ? null : getPlan();
    if (args.plan_id && !record) return missingPlan(args.plan_id);
    if (!record && !args.goal) return missingPlan();

    const subject = record ? `the plan ${record.id}:\n${record.text}` : `the following goal:\n${args.goal}`;
    const criteria = args.acceptance_criteria ? `\n\nAdditional Acceptance Criteria:\n${args.acceptance_criteria}` : "";
    const box: { review?: Review } = {};
    const report = await runSubagent({
      role: "reviewer",
      taskDescription: `Review the codebase changes for ${subject}${criteria}\n\n${await changes(record)}`,
      systemPrompt: getReviewerPrompt(),
      allowedTools: [...REVIEWER_TOOLS, submitReviewTool(box)],
      maxTurns: 8,
      label: "reviewer",
      finishOn: "submit_review"
    });

    // No submitted verdict is not an approval.
    const review: Review = box.review ?? {
      verdict: "changes_requested",
      summary: "The reviewer did not submit a verdict.",
      issues: [{ problem: `No structured review was submitted. The reviewer's last words: ${report.slice(0, 1_500)}` }]
    };
    if (record) {
      record.reviews++;
      record.lastReview = review;
    }
    return renderReview(review, record);
  }
};

/** Each pipeline role's allowlist - the only tools its subagent is ever offered. */
export const ROLE_TOOLS = {
  planner: PLANNER_TOOLS,
  worker: WORKER_TOOLS,
  reviewer: REVIEWER_TOOLS
};
