import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types.js";
import { noteRead } from "../context.js";

export interface WriteFileArgs {
  path: string;
  content: string;
}

/**
 * Tool for creating or overwriting a file with content.
 */
export const writeFileTool: Tool<WriteFileArgs, string> = {
  name: "write_file",
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a file, or overwrite it if it already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to create or overwrite"
          },
          content: {
            type: "string",
            description: "Content to write into the file"
          }
        },
        required: ["path", "content"]
      }
    }
  },
  execute: async ({ path: targetPath, content }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), targetPath);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf-8");
      noteRead(targetPath);
      return `Wrote ${targetPath}`;
    } catch (err: any) {
      return `Error writing file "${targetPath}": ${err.message || String(err)}`;
    }
  }
};
