import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types.js";

export interface ReadFileArgs {
  path: string;
}

/**
 * Tool for reading the full contents of a file.
 */
export const readFileTool: Tool<ReadFileArgs, string> = {
  name: "read_file",
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file and return its contents.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read"
          }
        },
        required: ["path"]
      }
    }
  },
  execute: async ({ path: targetPath }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), targetPath);
      const content = await fs.readFile(resolvedPath, "utf-8");
      return content || "(file is empty)";
    } catch (err: any) {
      return `Error reading file "${targetPath}": ${err.message || String(err)}`;
    }
  }
};
