/**
 * State of the plan -> work -> review pipeline.
 *
 * Plans are stored, not copied. The planner's report used to come back as a
 * tool result and then be re-emitted, in full, as work_task's arguments:
 * paid for again as output tokens, and parked in the transcript as an
 * assistant message nothing could shrink. Now the plan is written once to
 * .agents/artifacts/ and the pipeline passes a plan_id around.
 *
 * The same record carries what the reviewer needs to see every change (a
 * snapshot of the tree from before the first worker ran) and how many rework
 * cycles have been spent, so the loop is bounded in code rather than by a
 * sentence in a prompt.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type Verdict = "approved" | "changes_requested";

export interface Issue {
  file?: string;
  line?: number;
  problem: string;
  fix?: string;
}

export interface Review {
  verdict: Verdict;
  summary: string;
  issues: Issue[];
}

export interface PlanRecord {
  id: string;
  path: string;
  text: string;
  /** Tree of the working directory before the first work_task; null outside git. */
  baseline?: string | null;
  reworks: number;
  reviews: number;
  lastReview?: Review;
}

const PLANS = new Map<string, PlanRecord>();
let latest: string | null = null;

/** <project>/.agents/artifacts - ignored by git through its own .gitignore. */
export function artifactsDir(): string {
  const dir = path.join(process.cwd(), ".agents", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    // Keeps plans and diffs out of `git status`, out of review snapshots, and
    // out of the "files changed" reminders, without touching the project's
    // own .gitignore.
    fs.writeFileSync(ignore, "*\n", "utf-8");
  }
  return dir;
}

const digest = (text: string) => crypto.createHash("sha256").update(text.trim()).digest("hex");

/**
 * Store a plan and return its record. The same text twice gives the same id,
 * so pasting a plan again cannot reset its rework count.
 */
export function savePlan(text: string): PlanRecord {
  const hash = digest(text);
  for (const record of PLANS.values()) {
    if (digest(record.text) === hash) {
      latest = record.id;
      return record;
    }
  }
  const id = `plan-${PLANS.size + 1}-${hash.slice(0, 6)}`;
  const file = path.join(artifactsDir(), `${id}.md`);
  fs.writeFileSync(file, text, "utf-8");
  const record: PlanRecord = { id, path: file, text, reworks: 0, reviews: 0 };
  PLANS.set(id, record);
  latest = id;
  return record;
}

/**
 * A plan by id, or the newest one. Plans from an earlier session are read
 * back from disk - with fresh counters, since those were never saved.
 */
export function getPlan(id?: string): PlanRecord | null {
  const wanted = id?.trim() || latest;
  if (!wanted) return null;
  const known = PLANS.get(wanted);
  if (known) return known;
  if (!/^plan-[\w-]+$/.test(wanted)) return null;
  const file = path.join(process.cwd(), ".agents", "artifacts", `${wanted}.md`);
  if (!fs.existsSync(file)) return null;
  const record: PlanRecord = { id: wanted, path: file, text: fs.readFileSync(file, "utf-8"), reworks: 0, reviews: 0 };
  PLANS.set(wanted, record);
  return record;
}

export function knownPlans(): string[] {
  return [...PLANS.keys()];
}

export function resetPipeline(): void {
  PLANS.clear();
  latest = null;
}

/** Rework cycles left for this plan after its last review. */
export function reworksLeft(record: PlanRecord): number {
  return Math.max(0, config.maxRework - record.reworks);
}

function line(issue: Issue, index: number): string {
  const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""} - ` : "";
  const fix = issue.fix ? `\n   fix: ${issue.fix}` : "";
  return `${index + 1}. ${where}${issue.problem}${fix}`;
}

export function renderIssues(issues: Issue[]): string {
  return issues.map(line).join("\n");
}

/**
 * What review_task hands back to the orchestrator. The first line is the
 * machine-readable verdict - the UI keys off it, and only off it.
 */
export function renderReview(review: Review, record: PlanRecord | null): string {
  const head = review.verdict === "approved" ? "VERDICT: APPROVED" : "VERDICT: CHANGES_REQUESTED";
  const where = record
    ? ` (${record.id}, review ${record.reviews}, rework cycles used ${record.reworks} of ${config.maxRework})`
    : "";
  const parts = [`${head}${where}`, review.summary.trim()];
  if (review.issues.length > 0) parts.push(`Issues:\n${renderIssues(review.issues)}`);

  if (review.verdict === "changes_requested") {
    if (!record) {
      parts.push("Next: call work_task with these issues as instructions.");
    } else if (reworksLeft(record) > 0) {
      parts.push(
        `Next: call work_task with plan_id "${record.id}". These issues are passed to the worker automatically; ` +
        "add instructions only if you disagree with or want to narrow them."
      );
    } else {
      parts.push(
        `Rework limit reached (${config.maxRework} of ${config.maxRework}). Do not dispatch the worker again - ` +
        "report the open issues to the user and let them decide."
      );
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Parse and normalise what the reviewer passed to submit_review. */
export function parseReview(args: Record<string, any>): Review | string {
  const verdict = String(args.verdict || "").toLowerCase().replace(/[\s-]/g, "_");
  if (verdict !== "approved" && verdict !== "changes_requested") {
    return 'Error: verdict must be "approved" or "changes_requested".';
  }
  const issues: Issue[] = (Array.isArray(args.issues) ? args.issues : [])
    .filter((issue: any) => issue && typeof issue === "object" && issue.problem)
    .map((issue: any) => ({
      file: issue.file ? String(issue.file) : undefined,
      line: Number.isFinite(Number(issue.line)) && Number(issue.line) > 0 ? Number(issue.line) : undefined,
      problem: String(issue.problem),
      fix: issue.fix ? String(issue.fix) : undefined
    }));
  if (verdict === "changes_requested" && issues.length === 0) {
    return "Error: changes_requested needs at least one issue - say what is wrong and how to fix it.";
  }
  return { verdict, summary: String(args.summary || "").trim(), issues };
}
