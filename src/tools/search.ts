/**
 * grep and glob that do not depend on the shell.
 *
 * On Windows the shell may be PowerShell, where `grep -rn` and `find -name`
 * do not exist; a quarter of the recorded bash calls failed on exactly that
 * kind of mismatch. These run the same everywhere, respect .gitignore inside
 * a repository, and skip binaries.
 */

import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import { git } from "../git.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".venv", "__pycache__"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 300;

/** Translate a glob (`src/**\/*.ts`, `*.{js,ts}`) into an anchored regex over forward-slash paths. */
export function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      const options = glob.slice(i + 1, end).split(",").map((o) => globToRegex(o).source.slice(1, -1));
      out += `(?:${options.join("|")})`;
      i = end;
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

/** Does a relative path match? A pattern without a slash matches the file name anywhere. */
export function matches(relative: string, glob: string): boolean {
  const regex = globToRegex(glob.replace(/\\/g, "/").replace(/^\.\//, ""));
  return glob.includes("/") ? regex.test(relative) : regex.test(path.posix.basename(relative));
}

function walk(root: string, out: string[], relative = ""): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, out, child);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
}

/** Files under `root`, relative and with forward slashes. Uses git's view when there is one. */
export async function listFiles(root: string): Promise<string[]> {
  const fromGit = await git(["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, timeout: 15_000 });
  if (fromGit) {
    return [...new Set(fromGit.split("\0").filter(Boolean))].filter((f) => {
      try {
        return fs.statSync(path.join(root, f)).isFile(); // deleted-but-tracked files are still listed
      } catch {
        return false;
      }
    });
  }
  const out: string[] = [];
  walk(root, out);
  return out;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_000).includes(0);
}

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  max_results?: number;
}

export const grepTool: Tool<GrepArgs, string> = {
  name: "grep",
  schema: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with a regular expression (JavaScript syntax). Works the same on every OS, " +
        "respects .gitignore, skips binary files. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: { type: "string", description: "File or directory to search (default: the working directory)" },
          glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts' or 'src/**/*.test.ts'" },
          ignore_case: { type: "boolean", description: "Case-insensitive match" },
          max_results: { type: "number", description: "Stop after this many matching lines (default 200)" }
        },
        required: ["pattern"]
      }
    }
  },
  execute: async ({ pattern, path: target = ".", glob, ignore_case = false, max_results = 200 }) => {
    if (typeof pattern !== "string" || !pattern) return "Error: pattern must be a non-empty string.";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignore_case ? "i" : "");
    } catch (err: any) {
      return `Error: invalid regular expression: ${err.message}`;
    }

    const resolved = path.resolve(process.cwd(), target);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return `Error: ${target} does not exist.`;
    }
    const root = stat.isDirectory() ? resolved : path.dirname(resolved);
    const files = stat.isDirectory() ? await listFiles(root) : [path.basename(resolved)];
    const limit = Math.max(1, Math.min(Number(max_results) || 200, 2_000));

    const hits: string[] = [];
    let truncated = false;
    for (const file of files.sort()) {
      if (glob && !matches(file, glob)) continue;
      const full = path.join(root, file);
      let buffer: Buffer;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        buffer = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      const shown = path.relative(process.cwd(), full).replace(/\\/g, "/") || file;
      const lines = buffer.toString("utf-8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        const text = lines[i].length > MAX_LINE ? `${lines[i].slice(0, MAX_LINE)}...` : lines[i];
        hits.push(`${shown}:${i + 1}: ${text}`);
      }
      if (truncated) break;
    }
    if (hits.length === 0) return `No matches for /${pattern}/ in ${target}.`;
    return hits.join("\n") + (truncated ? `\n[stopped at ${limit} matches - narrow the pattern, path or glob]` : "");
  }
};

export interface GlobArgs {
  pattern: string;
  path?: string;
}

export const globTool: Tool<GlobArgs, string> = {
  name: "glob",
  schema: {
    type: "function",
    function: {
      name: "glob",
      description:
        "List files matching a glob such as 'src/**/*.ts' or '*.md' (a pattern without '/' matches file names anywhere). " +
        "Respects .gitignore. Works the same on every OS.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory to search from (default: the working directory)" }
        },
        required: ["pattern"]
      }
    }
  },
  execute: async ({ pattern, path: target = "." }) => {
    if (typeof pattern !== "string" || !pattern) return "Error: pattern must be a non-empty string.";
    const root = path.resolve(process.cwd(), target);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return `Error: ${target} is not a directory.`;
    const found = (await listFiles(root)).filter((file) => matches(file, pattern)).sort();
    if (found.length === 0) return `No files match ${pattern} in ${target}.`;
    const limit = 500;
    const shown = found.slice(0, limit).map((f) => path.relative(process.cwd(), path.join(root, f)).replace(/\\/g, "/"));
    return shown.join("\n") + (found.length > limit ? `\n[${found.length - limit} more - narrow the pattern]` : "");
  }
};
