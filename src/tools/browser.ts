import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./types.js";

const execAsync = promisify(exec);

export interface BrowserToolArgs {
  command: string;
}

export const browserTool: Tool<BrowserToolArgs, string> = {
  name: "browser",
  schema: {
    type: "function",
    function: {
      name: "browser",
      description:
        "Fast, robust browser automation powered by agent-browser. Run commands such as 'open https://example.com', 'snapshot -i', 'click @e1', 'fill @e2 text', 'keyboard type CRANE', 'press Enter', 'wait 1500', 'close'. Always use refs (@e1, @e2) from snapshot -i to interact deterministically.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The agent-browser command to run (e.g. 'open https://example.com', 'snapshot -i', 'click @e1', 'keyboard type CRANE', 'press Enter', 'close')"
          }
        },
        required: ["command"]
      }
    }
  },
  execute: async ({ command }: BrowserToolArgs) => {
    if (!command || typeof command !== "string") {
      return "Error: A command string is required.";
    }

    try {
      const { stdout, stderr } = await execAsync(`npx agent-browser ${command.trim()}`, {
        timeout: 35000,
        env: { ...process.env, NO_COLOR: "1" }
      });
      const output = (stdout || "") + (stderr ? `\n${stderr}` : "");
      return output.trim() || "✓ Done";
    } catch (err: any) {
      const errOut = (err.stdout || "") + (err.stderr || "") + (err.message || String(err));
      return errOut.trim() || "Error executing command.";
    }
  }
};
