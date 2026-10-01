import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types.js";
import { noteRead } from "../context.js";

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

/**
 * Tool for reading the contents of a file with optional pagination.
 */
export const readFileTool: Tool<ReadFileArgs, string> = {
  name: "read_file",
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file and return its contents. For large files, use offset and limit to page through line by line.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read"
          },
          offset: {
            type: "number",
            description: "Optional line number (1-based) to start reading from"
          },
          limit: {
            type: "number",
            description: "Optional maximum number of lines to read"
          }
        },
        required: ["path"]
      }
    }
  },
  execute: async ({ path: targetPath, offset, limit }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), targetPath);
      const content = await fs.readFile(resolvedPath, "utf-8");
      noteRead(targetPath);

      if (!content) {
        return "(file is empty)";
      }

      if (offset != null || limit != null) {
        const lines = content.split("\n");
        const start = Math.max(1, offset || 1);
        const count = limit != null && limit > 0 ? limit : lines.length;
        const selected = lines.slice(start - 1, start - 1 + count);
        const end = Math.min(lines.length, start + selected.length - 1);
        const header = `[Lines ${start} to ${end} of ${lines.length}]:\n`;
        return header + selected.join("\n");
      }

      return content;
    } catch (err: any) {
      return `Error reading file "${targetPath}": ${err.message || String(err)}`;
    }
  }
};
