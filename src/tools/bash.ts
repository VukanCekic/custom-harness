import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

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
      const shell =
        process.platform === "win32"
          ? "powershell.exe"
          : process.env.SHELL || "/bin/bash";

      const { stdout, stderr } = await execAsync(command, {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        shell
      });

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
