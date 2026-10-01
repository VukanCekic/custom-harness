import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types.js";
import { noteWrite } from "../context.js";

export interface StringReplaceArgs {
  path: string;
  old_str: string;
  new_str: string;
  allow_multi_edit?: boolean;
}

/**
 * Tool for swapping exact text in a file.
 * Matches exact text; old_str must match uniquely unless allow_multi_edit is true.
 */
export const stringReplaceTool: Tool<StringReplaceArgs, string> = {
  name: "str_replace",
  schema: {
    type: "function",
    function: {
      name: "str_replace",
      description: "Swap exact text in a file. old_str must match exactly once unless allow_multi_edit is set to true.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to modify"
          },
          old_str: {
            type: "string",
            description: "Exact text to replace"
          },
          new_str: {
            type: "string",
            description: "Replacement text"
          },
          allow_multi_edit: {
            type: "boolean",
            description: "Set to true to replace all occurrences if old_str matches more than once"
          }
        },
        required: ["path", "old_str", "new_str"]
      }
    }
  },
  execute: async ({ path: targetPath, old_str, new_str, allow_multi_edit = false }) => {
    try {
      const resolvedPath = path.resolve(process.cwd(), targetPath);
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, "utf-8");
      } catch (err: any) {
        return `Error reading file "${targetPath}": ${err.message || String(err)}`;
      }

      if (old_str === "") {
        return "Error: old_str cannot be empty";
      }

      let find = old_str;
      let swap = new_str;
      let count = content.split(find).length - 1;
      if (count === 0 && content.includes("\r\n") && !find.includes("\r\n")) {
        // The model writes \n; a file checked out with core.autocrlf=true has \r\n.
        find = find.replace(/\n/g, "\r\n");
        swap = swap.replace(/\r?\n/g, "\r\n");
        count = content.split(find).length - 1;
      }
      if (count === 0) {
        return `Error: old_str was not found in ${targetPath}`;
      }

      if (count > 1 && !allow_multi_edit) {
        return (
          `Error: old_str matches ${count} times in ${targetPath}. ` +
          "Add surrounding lines to make it unique, " +
          "or set allow_multi_edit to replace them all."
        );
      }

      // Plain text on both sides. With a string replacement, String.replace
      // expands $$, $& and $' in new_str - Makefiles and shell scripts are
      // full of them, and it silently spliced the rest of the file into the edit.
      const newContent = allow_multi_edit
        ? content.split(find).join(swap)
        : content.replace(find, () => swap);

      await fs.writeFile(resolvedPath, newContent, "utf-8");
      noteWrite(targetPath);
      return `Replaced ${count} match(es) in ${targetPath}`;
    } catch (err: any) {
      return `Error replacing text in "${targetPath}": ${err.message || String(err)}`;
    }
  }
};
