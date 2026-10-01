import type { Tool } from "./types.js";
import { run } from "../sandbox.js";

export interface BashArgs {
  command: string;
}

/**
 * Bash tool for executing shell commands and capturing stdout + stderr.
 */
export const bashTool: Tool<BashArgs, string> = {
  name: "bash",
  schema: {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command and return its output.",
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
    try {
      const { stdout, stderr } = await run(command);
      const output = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
      return output || "[Command executed successfully with no output]";
    } catch (err: any) {
      const errorOutput = (
        (err.stdout ? err.stdout + "\n" : "") +
        (err.stderr || err.message || String(err))
      ).trim();
      return errorOutput || "Command failed with unknown error.";
    }
  }
};
