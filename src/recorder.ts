import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import type { DetailedUsage, Spend, TimingMetrics } from "./llm.js";
import type { CacheBreak } from "./cache.js";
import type { CompactionRecord, StepRecord } from "./agent.js";
import type { Role } from "./scope.js";
import { sessionDir } from "./session.js";

export interface RunRecord {
  id: string;
  timestamp: string;
  session?: string;
  prompt: string;
  model: string;
  mode?: string;
  steps: number;
  cancelled?: boolean;
  final_response: string | null;
  /** The last step's usage, with `cost` replaced by the whole turn's cost. */
  usage: DetailedUsage | null;
  metrics: TimingMetrics | null;
  /** Usage of every main-loop request. */
  step_usage?: StepRecord[];
  /** cached / prompt tokens across the turn's main-loop requests. */
  cache_hit_rate?: number | null;
  cache_breaks?: Array<CacheBreak & { step: number }>;
  compactions?: CompactionRecord[];
  /** Main loop, each subagent role, and compaction - everything the turn paid for. */
  cost_by_role?: Partial<Record<Role, Spend>>;
  transcript: ChatMessages[];
}

/**
 * Saves a completed run as a structured JSON file, next to the session logs
 * (never inside the project the agent is working on).
 */
export async function saveRunResult(
  data: Omit<RunRecord, "id" | "timestamp">,
  dir = path.join(sessionDir(), "runs")
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });

  const now = new Date();
  // YYYY-MM-DD_HH-mm-ss-SSS: two runs in one second used to overwrite each other
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  const id = `run_${dateStr}_${timeStr}`;

  const filePath = path.join(dir, `${id}.json`);

  const record: RunRecord = {
    id,
    timestamp: now.toISOString(),
    ...data
  };

  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
  return filePath;
}
