import { insideProject, PROJECT_ROOT, shellKind } from "./sandbox.js";
import { browserTarget, parseBrowserArgs } from "./tools/browser.js";
import { config } from "./config.js";
import { isSpill } from "./history.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionCheck {
  action: PermissionAction;
  reason?: string;
  /** Called once the user approves, to stop asking about the same thing this session. */
  remember?: () => void;
}

/** Paths whose contents should never reach the model without a human saying so. */
const SECRETS =
  /(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|\bgh[\\/]hosts\.ya?ml|\bid_(rsa|ed25519|ecdsa)\b|\bcredentials\b|(^|[\s/\\"'=<])\.env(\.|\b|$))/i;

/** Names SECRETS protects, to test shell globs against: `cat .en?` is `cat .env`. */
const SECRET_NAMES = [".env", ".env.local", ".env.production", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "id_rsa", "id_ed25519", "id_ecdsa"];

/**
 * The words of a command as the shell sees them once quotes and escapes are
 * gone - `.e''nv`, `".env"` and `.e\nv` are all `.env` - and whether each one
 * still holds an unquoted glob character the shell will expand.
 */
function words(command: string, posix: boolean): Array<{ word: string; glob: boolean }> {
  const escape = posix ? "\\" : "`";
  const out: Array<{ word: string; glob: boolean }> = [];
  let word = "";
  let glob = false;
  let quote: string | null = null;
  const flush = () => {
    if (word) out.push({ word, glob });
    word = "";
    glob = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === escape) {
      word += command[++index] ?? "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/[\s;&|<>()]/.test(char)) {
      flush();
    } else {
      if (char === "*" || char === "?" || char === "[") glob = true;
      word += char;
    }
  }
  flush();
  return out;
}

function globMatches(pattern: string, name: string): boolean {
  const regex = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^${regex}$`, "i").test(name);
  } catch {
    return true; // an odd bracket expression: assume the worst
  }
}

/**
 * Could this word, once the shell has expanded it, name a credentials file?
 * Globs follow the shell's rules: a leading dot has to be written out, and a
 * pattern of nothing but wildcards (`ls *`, `cat src/*`) aims at no file in
 * particular - asking about those would make every listing need approval.
 */
function touchesSecret({ word, glob }: { word: string; glob: boolean }): boolean {
  if (SECRETS.test(word)) return true;
  if (!glob) return false;
  const base = word.split(/[\\/]/).pop() ?? word;
  if (!/[^*?]/.test(base.replace(/\[[^\]]*\]/g, ""))) return false;
  return SECRET_NAMES.some((name) => name.startsWith(".") === base.startsWith(".") && globMatches(base, name));
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
      index++;
    } else if (!posix && char === "(") {
      // PowerShell evaluates (...) and @(...) anywhere in a command line:
      // `Get-Content (Remove-Item -Recurse src)` deletes src.
      found.add("runs a subexpression");
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

  if (SECRETS.test(command) || words(command, posix).some(touchesSecret)) {
    found.add("reads or writes a credentials file");
  }
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
  /^find\b.*\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/i,
  /^git\s+branch\b.*\s(-d|-D|-m|-M|-c|-C|-f|-u|-t|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--track|--edit-description)\b/,
  /^git\s+(diff|log|show)\b.*\s--output\b/,
  /^git\s+diff\b.*\s--no-index\b/, // diffs any two files on disk, outside the project too
  /^sort\b.*\s(-[a-zA-Z]*o|--o)/, // -o FILE, -oFILE, -uo FILE, and GNU's abbreviations --out=, --outp=...
  /^tree\b.*\s-o/,
  /^(rg|ripgrep)\b.*\s--pre\b/, // runs COMMAND on every file it searches
  /^date\b.*\s(-s|--set)\b/,
  /^(Get-ChildItem|gci|dir|ls)\b.*\benv:/i
];

/** `uniq INPUT OUTPUT` writes OUTPUT. */
function uniqWrites(part: string): boolean {
  const [command, ...rest] = part.trim().split(/\s+/);
  return command === "uniq" && rest.filter((arg) => !arg.startsWith("-")).length >= 2;
}

/**
 * Allow-listed commands that run the project's own code (conftest.py, test
 * files). Fine while a human can watch; not for a role that cannot ask, since
 * write_file needs no approval inside the project and pytest would run it.
 */
const RUNS_PROJECT_CODE: RegExp[] = [/^pytest\b/i, /^python3?\s+-m\s+pytest\b/i];

/**
 * Rate every part of a compound command; the strictest verdict wins.
 * Precedence: deny > ask > allow. `strict` is for callers that cannot ask.
 */
export function decide(command: string, posix = shellKind() === "posix", strict = false): PermissionAction {
  const verdicts: PermissionAction[] = [];

  for (const part of splitCommand(command, posix)) {
    let action: PermissionAction = "ask";
    for (const [pattern, rule] of BASH_RULES) {
      if (matchPattern(part, pattern)) {
        action = rule;
      }
    }
    const trimmed = part.trim();
    if (action === "allow" && (RISKY_FLAGS.some((flag) => flag.test(trimmed)) || uniqWrites(trimmed))) {
      action = "ask";
    }
    if (strict && action === "allow" && RUNS_PROJECT_CODE.some((rule) => rule.test(trimmed))) {
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
 * Return (action, reason). Action is allow, ask or deny. `strict` is set for
 * callers that cannot ask (read-only subagents, pipeline-mode bash).
 */
export function check(name: string, args: Record<string, any>, options: { strict?: boolean } = {}): PermissionCheck {
  if (name === "browser") {
    return checkBrowser(args);
  }

  // The harness's own temp files, written for this agent to page through.
  // They live in the OS temp directory, so the outside-the-project rule used
  // to ask every time - and refuse read-only roles outright.
  if ((name === "read_file" || name === "grep") && args.path && isSpill(String(args.path))) {
    return { action: "allow" };
  }

  if ((name === "grep" || name === "glob") && args.path) {
    if (!insideProject(String(args.path))) {
      return { action: "ask", reason: `${name} outside ${PROJECT_ROOT}: ${args.path}` };
    }
    if (SECRETS.test(String(args.path))) {
      return { action: "ask", reason: `${name} on a credentials file: ${args.path}` };
    }
  }

  if (name === "bash") {
    const cmd = String(args.command || "");
    const why = effects(cmd);
    return {
      action: decide(cmd, undefined, options.strict),
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
