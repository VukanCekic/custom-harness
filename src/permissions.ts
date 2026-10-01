import { insideProject, PROJECT_ROOT, shellKind } from "./sandbox.js";
import { browserTarget, parseBrowserArgs } from "./tools/browser.js";
import { config } from "./config.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionCheck {
  action: PermissionAction;
  reason?: string;
  /** Called once the user approves, to stop asking about the same thing this session. */
  remember?: () => void;
}

/** Paths whose contents should never reach the model without a human saying so. */
const SECRETS = /(\.ssh|\.aws|\.gnupg|\.netrc|\bid_(rsa|ed25519|ecdsa)\b|\bcredentials\b|(^|[\s/\\"'=])\.env(\.|\b|$))/i;

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
 * Anything quoted or escaped is an argument, not a separator. The escape
 * character depends on the shell: PowerShell's is the backtick, and treating
 * "\" as one there let `dir .\;Remove-Item ...` through as a single "dir".
 */
export function splitCommand(command: string, posix = shellKind() === "posix"): string[] {
  const escape = posix ? "\\" : "`";
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
    } else if (char === escape) {
      current.push(char);
      index++;
      if (index < command.length) {
        current.push(command[index]);
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      current.push(char);
    } else if (char === "&" && (command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">")) {
      // part of a redirection (2>&1, &>file), not a separator - splitting here
      // left a bare "1" that matched no rule, so every 2>&1 asked for approval
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
 * Shell syntax that writes a file or runs another command from inside what
 * looks like one harmless argument. A rule like "echo *" cannot see past any
 * of it, so each one escalates the whole command to ask.
 */
export function effects(command: string, posix = shellKind() === "posix"): string[] {
  const found = new Set<string>();
  const escape = posix ? "\\" : "`";
  let quote: string | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1] ?? "";
    if (char === escape && quote !== "'") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      // Double quotes do not stop substitution in bash or PowerShell.
      else if (quote === '"' && char === "$" && next === "(") found.add("runs a command substitution");
      else if (quote === '"' && posix && char === "`") found.add("runs a command substitution");
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "$" && next === "(") {
      found.add("runs a command substitution");
    } else if (posix && char === "`") {
      found.add("runs a command substitution");
    } else if ((char === "<" || char === ">") && next === "(") {
      found.add("runs a process substitution");
    } else if (char === "\n" || char === "\r") {
      found.add("spans several lines");
    } else if (char === ">") {
      let at = index + 1;
      if (command[at] === ">") at++;
      if (command[at] === "&") continue; // 2>&1
      while (command[at] === " ") at++;
      const target = command.slice(at).match(/^[^\s;&|]+/)?.[0] ?? "";
      if (!/^(\/dev\/null|\$null|nul)$/i.test(target)) {
        found.add(`writes to ${target || "a file"}`);
      }
    }
  }

  if (SECRETS.test(command)) found.add("reads or writes a credentials file");
  return [...found];
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
  // "env" is gone: it printed every variable, the API key included.
  ["cat *", "allow"],
  ["head *", "allow"],
  ["tail *", "allow"],
  // bare, at the end of a pipe: `git log | head` used to ask
  ["head", "allow"],
  ["tail", "allow"],
  ["wc", "allow"],
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
 * Flags that turn an allow-listed reader into a writer.
 */
const RISKY_FLAGS: RegExp[] = [
  /^find\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/i,
  /^git\s+branch\b.*\s(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force)\b/,
  /^git\s+(diff|log|show)\b.*\s--output\b/,
  /^sort\b.*\s(-o|--output)\b/,
  /^tree\b.*\s-o\b/,
  /^(Get-ChildItem|gci|dir|ls)\b.*\benv:/i
];

/**
 * Rate every part of a compound command; the strictest verdict wins.
 * Precedence: deny > ask > allow
 */
export function decide(command: string, posix = shellKind() === "posix"): PermissionAction {
  const verdicts: PermissionAction[] = [];

  for (const part of splitCommand(command, posix)) {
    let action: PermissionAction = "ask";
    for (const [pattern, rule] of BASH_RULES) {
      if (matchPattern(part, pattern)) {
        action = rule;
      }
    }
    if (action === "allow" && RISKY_FLAGS.some((flag) => flag.test(part.trim()))) {
      action = "ask";
    }
    verdicts.push(action);
  }
  if (effects(command, posix).length > 0) {
    verdicts.push("ask");
  }

  for (const strictest of ["deny", "ask"] as const) {
    if (verdicts.includes(strictest)) {
      return strictest;
    }
  }
  return "allow";
}

// hosts the user approved for the browser this session
const APPROVED_HOSTS = new Set<string>();

export function resetPermissions(): void {
  APPROVED_HOSTS.clear();
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return [...config.browserAllowHosts, ...APPROVED_HOSTS].some((allowed) => {
    const a = allowed.toLowerCase();
    return h === a || h.endsWith(`.${a}`);
  });
}

/**
 * The browser can go anywhere and run anything: `open` takes any URL and
 * `eval` runs arbitrary JavaScript in a real, possibly logged-in, page.
 */
function checkBrowser(args: Record<string, any>): PermissionCheck {
  const intent = parseBrowserArgs(args);
  if (intent.action === "eval") {
    const js = String(intent.js || "");
    return { action: "ask", reason: `browser eval: ${js.length > 200 ? `${js.slice(0, 200)}...` : js}` };
  }
  if (intent.action === "open" && intent.url) {
    const target = browserTarget(intent.url);
    let host: string;
    try {
      const parsed = new URL(target);
      if (!/^https?:$/.test(parsed.protocol)) {
        return { action: "ask", reason: `browser open (${parsed.protocol} URL): ${target}` };
      }
      host = parsed.hostname;
    } catch {
      return { action: "ask", reason: `browser open (unparseable URL): ${target}` };
    }
    if (!hostAllowed(host)) {
      return {
        action: "ask",
        reason: `browser open ${host} (approving allows ${host} for this session): ${target}`,
        remember: () => APPROVED_HOSTS.add(host.toLowerCase())
      };
    }
  }
  return { action: "allow" };
}

/**
 * Return (action, reason). Action is allow, ask or deny.
 */
export function check(name: string, args: Record<string, any>): PermissionCheck {
  if (name === "browser") {
    return checkBrowser(args);
  }

  if ((name === "grep" || name === "glob") && args.path && !insideProject(String(args.path))) {
    return { action: "ask", reason: `${name} outside ${PROJECT_ROOT}: ${args.path}` };
  }

  if (name === "bash") {
    const cmd = String(args.command || "");
    const why = effects(cmd);
    return {
      action: decide(cmd),
      reason: why.length > 0 ? `run (${why.join(", ")}): ${cmd}` : `run: ${cmd}`
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
    if (SECRETS.test(String(args.path))) {
      return { action: "ask", reason: `${name} on a credentials file: ${args.path}` };
    }
  }

  return { action: "allow" };
}
