import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types.js";
import { noteRead } from "../context.js";

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

const WHOLE_FILE_LIMIT = 2 * 1024 * 1024; // bytes read without offset/limit
const PAGED_FILE_LIMIT = 64 * 1024 * 1024; // bytes read at all

function numbered(lines: string[], first: number): string {
  return lines.map((line, i) => `${first + i}\t${line}`).join("\n");
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
        "Read a text file. Each line comes back prefixed with its line number and a tab - the prefix is not " +
        "part of the file, so leave it out of str_replace's old_str. For large files, use offset and limit " +
        "to page through line by line.",
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
      const paged = offset != null || limit != null;
      const stat = await fs.stat(resolvedPath);
      if (stat.isDirectory()) {
        return `Error: "${targetPath}" is a directory. Use glob or bash to list it.`;
      }
      if (stat.size > (paged ? PAGED_FILE_LIMIT : WHOLE_FILE_LIMIT)) {
        return paged
          ? `Error: "${targetPath}" is ${stat.size} bytes - too big to read. Use grep to find what you need.`
          : `Error: "${targetPath}" is ${stat.size} bytes. Read it in pages with offset and limit, or grep it.`;
      }

      const buffer = await fs.readFile(resolvedPath);
      if (buffer.subarray(0, 8_000).includes(0)) {
        return `"${targetPath}" is a binary file (${stat.size} bytes); its contents are not shown.`;
      }
      const content = buffer.toString("utf-8");
      noteRead(targetPath);

      if (!content) {
        return "(file is empty)";
      }

      const lines = content.split(/\r?\n/);
      if (paged) {
        const start = Math.max(1, offset || 1);
        const count = limit != null && limit > 0 ? limit : lines.length;
        const selected = lines.slice(start - 1, start - 1 + count);
        const end = Math.min(lines.length, start + selected.length - 1);
        const header = `[Lines ${start} to ${end} of ${lines.length}]:\n`;
        return header + numbered(selected, start);
      }

      return numbered(lines, 1);
    } catch (err: any) {
      return `Error reading file "${targetPath}": ${err.message || String(err)}`;
    }
  }
};
