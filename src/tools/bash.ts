import type { Tool } from "./types.js";
import { run, shellKind } from "../sandbox.js";

export interface BashArgs {
  command: string;
}

// Without Git for Windows the "bash" tool is really Windows PowerShell 5.1,
// where &&, 2>/dev/null and `ls -la` all fail - a quarter of the recorded bash
// calls did. Say so up front rather than let the model find out by failing.
const SHELL_NOTE =
  shellKind() === "powershell"
    ? " Commands run in Windows PowerShell 5.1: chain with ';' (not &&), discard output with '2>$null', " +
      "and use Get-Content / Select-String instead of head / grep."
    : "";

/**
 * Bash tool for executing shell commands and capturing stdout + stderr.
 */
export const bashTool: Tool<BashArgs, string> = {
  name: "bash",
  schema: {
    type: "function",
    function: {
      name: "bash",
      description: `Run a shell command and return its output and exit code.${SHELL_NOTE}`,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run"
          }
        },
        required: ["command"]
      }
    }
  },
  execute: async ({ command }) => {
    if (typeof command !== "string" || !command.trim()) {
      return "Error: command must be a non-empty string.";
    }
    try {
      const { stdout, stderr } = await run(command);
      const output = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
      return output || "[Command executed successfully with no output]";
    } catch (err: any) {
      const output = ((err.stdout || "") + (err.stderr ? `\nSTDERR:\n${err.stderr}` : "")).trim();
      if (err.name === "AbortError") {
        return `${output}\n[cancelled before it finished]`.trim();
      }
      if (err.killed || err.signal) {
        // A slow command is the model's problem to work around, not a mystery.
        return `${output}\n[killed after 60s or for too much output (${err.signal || "SIGTERM"}). Narrow the command down.]`.trim();
      }
      // A grep with no match exits 1. "Command failed: grep ..." read like a crash.
      const status = typeof err.code === "number" ? `[exit code ${err.code}]` : `[${err.message || String(err)}]`;
      return `${output || "(no output)"}\n${status}`;
    }
  }
};
