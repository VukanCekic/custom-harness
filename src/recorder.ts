import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import type { DetailedUsage, TimingMetrics } from "./llm.js";

export interface RunRecord {
  id: string;
  timestamp: string;
  prompt: string;
  model: string;
  turns: number;
  final_response: string | null;
  usage: DetailedUsage | null;
  metrics: TimingMetrics | null;
  transcript: ChatMessages[];
}

/**
 * Saves a completed run to the test/ directory as a structured JSON file.
 */
export async function saveRunResult(
  data: Omit<RunRecord, "id" | "timestamp">
): Promise<string> {
  const testDir = path.resolve(process.cwd(), "test");
  await fs.mkdir(testDir, { recursive: true });

  const now = new Date();
  // Format readable timestamp: YYYY-MM-DD_HH-mm-ss
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const id = `run_${dateStr}_${timeStr}`;

  const filePath = path.join(testDir, `${id}.json`);

  const record: RunRecord = {
    id,
    timestamp: now.toISOString(),
    ...data
  };

  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
  return filePath;
}
