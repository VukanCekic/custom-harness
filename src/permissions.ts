import { insideProject, PROJECT_ROOT } from "./sandbox.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionCheck {
  action: PermissionAction;
  reason?: string;
}

/**
 * Wildcard matcher supporting * and ?
 */
export function matchPattern(text: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regexStr =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(regexStr, "i").test(text.trim());
}

/**
 * Split a compound command on the separators that actually separate.
 * Anything quoted or backslash-escaped is an argument, not a separator.
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let quote: string | null = null;
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    if (quote) {
      current.push(char);
      if (char === quote) {
        quote = null;
      }
    } else if (char === "\\") {
      current.push(char);
      index++;
      if (index < command.length) {
        current.push(command[index]);
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      current.push(char);
    } else if (char === "&" || char === "|" || char === ";") {
      parts.push(current.join(""));
      current = [];
      while (
        index + 1 < command.length &&
        (command[index + 1] === "&" || command[index + 1] === "|")
      ) {
        index++;
      }
    } else {
      current.push(char);
    }
    index++;
  }

  parts.push(current.join(""));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Rules for bash commands.
 * Last matching rule wins, so the catch-all '*' is first.
 */
export const BASH_RULES: Array<[string, PermissionAction]> = [
  // Catch-all
  ["*", "ask"],

  // Read-only / inspection commands: allow
  ["ls*", "allow"],
  ["pwd", "allow"],
  ["cd *", "allow"],
  ["echo *", "allow"],
  ["sort*", "allow"],
  ["uniq*", "allow"],
  ["cut *", "allow"],
  ["basename *", "allow"],
  ["dirname *", "allow"],
  ["date*", "allow"],
  ["env", "allow"],
  ["cat *", "allow"],
  ["head *", "allow"],
  ["tail *", "allow"],
  ["wc *", "allow"],
  ["file *", "allow"],
  ["which *", "allow"],
  ["grep *", "allow"],
  ["rg *", "allow"],
  ["find *", "allow"],
  ["tree*", "allow"],
  ["git status*", "allow"],
  ["git diff*", "allow"],
  ["git log*", "allow"],
  ["git show*", "allow"],
  ["git ls-files*", "allow"],
  ["git branch*", "allow"],
  ["pytest*", "allow"],
  ["python -m pytest*", "allow"],
  ["node -v*", "allow"],
  ["npm -v*", "allow"],

  // Windows / PowerShell read-only commands
  ["dir*", "allow"],
  ["Get-Content*", "allow"],
  ["Get-ChildItem*", "allow"],
  ["Get-Location", "allow"],
  ["Get-Date*", "allow"],
  ["Select-String*", "allow"],
  ["type *", "allow"],

  // Modifying, deletion, and risky commands: ask the user for approval
  ["rm *", "ask"],
  ["sudo *", "ask"],
  ["chmod *", "ask"],
  ["chown *", "ask"],
  ["curl *", "ask"],
  ["wget *", "ask"],
  ["git push*", "ask"],
  ["git reset*", "ask"],
  ["git clean*", "ask"],

  // Windows / PowerShell commands: ask the user for approval
  ["del *", "ask"],
  ["erase *", "ask"],
  ["rmdir *", "ask"],
  ["Remove-Item*", "ask"],
  ["Format-Volume*", "ask"],
  ["Clear-Disk*", "ask"]
];

/**
 * Rate every part of a compound command; the strictest verdict wins.
 * Precedence: deny > ask > allow
 */
export function decide(command: string): PermissionAction {
  const parts = splitCommand(command);
  const verdicts: PermissionAction[] = [];

  for (const part of parts) {
    let action: PermissionAction = "ask";
    for (const [pattern, rule] of BASH_RULES) {
      if (matchPattern(part, pattern)) {
        action = rule;
      }
    }
    verdicts.push(action);
  }

  for (const strictest of ["deny", "ask"] as const) {
    if (verdicts.includes(strictest)) {
      return strictest;
    }
  }
  return "allow";
}

/**
 * Return (action, reason). Action is allow, ask or deny.
 */
export function check(name: string, args: Record<string, any>): PermissionCheck {
  if (name === "bash") {
    const cmd = args.command || "";
    return {
      action: decide(cmd),
      reason: `run: ${cmd}`
    };
  }

  if (
    (name === "write_file" ||
      name === "str_replace" ||
      name === "string_replace" ||
      name === "read_file") &&
    args.path
  ) {
    if (!insideProject(args.path)) {
      return {
        action: "ask",
        reason: `${name} outside ${PROJECT_ROOT}: ${args.path}`
      };
    }
  }

  return { action: "allow" };
}
