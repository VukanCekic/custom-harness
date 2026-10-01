/**
 * Terminal presentation layer.
 *
 * Knows nothing about LLMs, providers or tools - it only receives plain strings
 * and dicts and decides how they look.
 * Modeled after rich terminal UI with Tokyo Night palette.
 */

import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------- palette

export const PALETTE = {
  ACCENT: { r: 122, g: 162, b: 247, hex: "#7aa2f7" }, // #7aa2f7 (soft blue / cyan)
  USER: { r: 158, g: 206, b: 106, hex: "#9ece6a" },   // #9ece6a (soft green)
  TOOL: { r: 224, g: 175, b: 104, hex: "#e0af68" },   // #e0af68 (warm gold / amber)
  MUTED: { r: 86, g: 95, b: 137, hex: "#565f89" },    // #565f89 (slate gray)
  BORDER: { r: 65, g: 72, b: 104, hex: "#414868" },   // subtle border
  TEXT: { r: 192, g: 202, b: 245, hex: "#c0caf5" },   // readable text
};

export const MAX_TOOL_OUTPUT_LINES = 12;

export const MARKS: Record<string, string> = {
  done: "✔",
  in_progress: "▶",
  pending: "○",
};

// ---------------------------------------------------------------- color helpers

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_ITALIC = "\x1b[3m";
const ANSI_STRIKE = "\x1b[9m";

export function rgb(r: number, g: number, b: number, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}${ANSI_RESET}`;
}

export function cAccent(text: string): string {
  return rgb(PALETTE.ACCENT.r, PALETTE.ACCENT.g, PALETTE.ACCENT.b, text);
}

export function cUser(text: string): string {
  return rgb(PALETTE.USER.r, PALETTE.USER.g, PALETTE.USER.b, text);
}

export function cTool(text: string): string {
  return rgb(PALETTE.TOOL.r, PALETTE.TOOL.g, PALETTE.TOOL.b, text);
}

export function cMuted(text: string): string {
  return rgb(PALETTE.MUTED.r, PALETTE.MUTED.g, PALETTE.MUTED.b, text);
}

export function cBorder(text: string): string {
  return rgb(PALETTE.BORDER.r, PALETTE.BORDER.g, PALETTE.BORDER.b, text);
}

export function cBold(text: string): string {
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

export function cItalic(text: string): string {
  return `${ANSI_ITALIC}${text}${ANSI_RESET}`;
}

export function cStrike(text: string): string {
  return `${ANSI_STRIKE}${text}${ANSI_RESET}`;
}

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(SGR, "");
}

export function visibleLength(str: string): number {
  return [...stripAnsi(str)].length;
}

/**
 * Make text from a tool or the model safe to print: no escape sequences
 * (colours, cursor moves, OSC hyperlinks and title changes, terminal queries),
 * no control characters, and carriage-return progress bars collapsed to
 * their final state. Tool output is untrusted; printed raw it can rewrite
 * what the user sees on screen.
 */
export function sanitize(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]?/g, "") // other escapes
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts.length > 1 ? parts.filter(Boolean).pop() ?? "" : line;
    })
    .join("\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * Break a line that may contain SGR colour codes into pieces at most `width`
 * visible characters wide, carrying the active colour onto each new piece.
 */
export function wrapAnsi(line: string, width: number): string[] {
  if (width <= 0 || visibleLength(line) <= width) return [line];
  const pieces: string[] = [];
  let current = "";
  let visible = 0;
  let active = "";
  // eslint-disable-next-line no-control-regex
  for (const token of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (!token) continue;
    if (token.startsWith("\x1b[")) {
      current += token;
      active = token === ANSI_RESET ? "" : active + token;
      continue;
    }
    for (const char of token) {
      if (visible === width) {
        pieces.push(current + ANSI_RESET);
        current = active;
        visible = 0;
      }
      current += char;
      visible++;
    }
  }
  if (visible > 0 || pieces.length === 0) pieces.push(current);
  return pieces;
}

// ---------------------------------------------------------------- markdown helper

export function formatMarkdown(text: string): string {
  const lines = text.split("\n");
  const formatted: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      formatted.push(cMuted(line));
      continue;
    }

    if (inCodeBlock) {
      formatted.push(`  ${rgb(158, 206, 106, line)}`);
      continue;
    }

    let l = line;

    // Headers: # / ## / ###
    if (/^#{1,3}\s+/.test(l)) {
      l = cBold(cAccent(l.replace(/^#{1,3}\s+/, "")));
      formatted.push(l);
      continue;
    }

    // List bullets (- or *)
    if (/^\s*[-*]\s+/.test(l)) {
      l = l.replace(/^(\s*)([-*])(\s+)/, (_, space, __, rest) => {
        return `${space}${cAccent("•")}${rest}`;
      });
    }

    // Bold **text**
    l = l.replace(/\*\*(.*?)\*\*/g, (_, content) => cBold(content));

    // Inline code `code`
    l = l.replace(/`([^`]+)`/g, (_, code) => cTool(code));

    formatted.push(l);
  }

  return formatted.join("\n");
}

// ---------------------------------------------------------------- panel renderer

interface PanelOptions {
  title?: string;
  titleColor?: (text: string) => string;
  borderColor?: (text: string) => string;
  paddingLeft?: number;
  width?: number;
}

export function renderPanel(
  content: string | string[],
  options: PanelOptions = {}
): string {
  const termWidth = process.stdout.columns || 80;
  const padLeft = options.paddingLeft ?? 2;
  const targetWidth = Math.max(20, Math.min(termWidth - padLeft - 2, options.width || 88));
  const padPrefix = " ".repeat(padLeft);

  const bCol = options.borderColor || cMuted;
  const tCol = options.titleColor || cAccent;

  const contentLines = Array.isArray(content)
    ? content
    : content.split("\n");

  const lines: string[] = [];

  // Top border
  if (options.title) {
    const rawTitle = ` ${stripAnsi(options.title)} `;
    const styledTitle = ` ${options.title} `;
    const titleLen = rawTitle.length;
    const remaining = Math.max(0, targetWidth - titleLen - 3);
    lines.push(
      padPrefix +
        bCol("╭─") +
        tCol(styledTitle) +
        bCol("─".repeat(remaining) + "╮")
    );
  } else {
    lines.push(padPrefix + bCol("╭" + "─".repeat(targetWidth - 2) + "╮"));
  }

  const innerWidth = targetWidth - 4; // 2 for borders, 2 for inner padding

  // Content body - long lines wrap instead of pushing the border off screen
  for (const rawLine of contentLines) {
    // If it's a divider rule inside the panel
    if (rawLine === "__DIVIDER__") {
      lines.push(
        padPrefix + bCol("├" + "─".repeat(targetWidth - 2) + "┤")
      );
      continue;
    }

    for (const piece of wrapAnsi(rawLine, innerWidth)) {
      const paddingRight = Math.max(0, innerWidth - visibleLength(piece));
      lines.push(
        padPrefix +
          bCol("│ ") +
          piece +
          " ".repeat(paddingRight) +
          bCol(" │")
      );
    }
  }

  // Bottom border
  lines.push(padPrefix + bCol("╰" + "─".repeat(targetWidth - 2) + "╯"));

  return lines.join("\n");
}

// ---------------------------------------------------------------- rule renderer

export function renderRule(
  label?: string,
  styleColor: (text: string) => string = cMuted
): string {
  const termWidth = process.stdout.columns || 80;
  const width = Math.min(termWidth - 4, 88);

  if (!label) {
    return "  " + styleColor("─".repeat(width));
  }

  const rawTitle = ` ${stripAnsi(label)} `;
  const titleLen = rawTitle.length;
  const leftCount = 3;
  const rightCount = Math.max(0, width - leftCount - titleLen);

  return (
    "  " +
    styleColor("─".repeat(leftCount)) +
    label +
    styleColor("─".repeat(rightCount))
  );
}

const money = (value: number) => `$${value.toFixed(6)}`;

export interface SpendLine {
  calls: number;
  cost: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

// ---------------------------------------------------------------- UI class

export class UI {
  private _totals: Record<string, number> = {};
  private _spinnerInterval: NodeJS.Timeout | null = null;
  private _streaming = false;
  private _lastInterrupt = 0;

  /** Input history, newest first (readline's order). Owned by the caller, who may persist it. */
  history: string[] = [];
  /** Called when Ctrl+C is pressed inside a prompt that is part of a running turn. */
  onInterrupt: (() => void) | null = null;

  // -------------------------------------------------------------- input

  banner(sandboxName = "none", modelName?: string, extras: string[] = []): void {
    console.log();
    const titleText = cBold(cAccent(" custom-harness "));
    console.log(renderRule(titleText, cMuted));

    const metaParts = [
      `sandbox: ${sandboxName}`,
      modelName ? `model: ${modelName}` : null,
      ...extras,
      "/help for commands · ctrl-d to exit"
    ].filter(Boolean);

    console.log(
      "    " + cMuted(metaParts.join("  ·  "))
    );
    console.log();
  }

  resumed(messages: Array<{ role: string }>, label = "resumed"): void {
    console.log(
      `  ${cMuted(`${label} · ${messages.length} messages`)}`
    );
  }

  /**
   * One readline prompt. Ctrl+C rejects the current line; Ctrl+D (end of
   * input) resolves to null.
   */
  private _prompt(
    promptStr: string,
    options: {
      history?: boolean;
      multiline?: boolean;
      /** What Ctrl+C does: clear the typed text, stay at the prompt, or leave it (null). */
      onSigint?: (pending: boolean) => "clear" | "stay" | "exit";
    }
  ): Promise<string | null> {
    if (!input.isTTY) return this._pipedPrompt(promptStr, Boolean(options.multiline));
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input,
        output,
        terminal: Boolean(input.isTTY && output.isTTY),
        history: options.history ? [...this.history] : [],
        historySize: options.history ? 1000 : 0,
        removeHistoryDuplicates: true
      });
      const lines: string[] = [];
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.history && value && value.trim()) {
          this.history = [value, ...this.history.filter((h) => h !== value)].slice(0, 1000);
        }
        rl.close();
        resolve(value);
      };

      rl.setPrompt(promptStr);
      rl.prompt();

      rl.on("line", (line) => {
        if (options.multiline && line.endsWith("\\")) {
          lines.push(line.slice(0, -1));
          rl.setPrompt(cMuted("  … "));
          rl.prompt();
          return;
        }
        lines.push(line);
        if (!options.multiline) return finish(lines.join("\n"));
        // A paste arrives as several lines at once: gather them for a moment
        // instead of sending the first and losing the rest.
        clearTimeout(timer);
        timer = setTimeout(() => finish(lines.join("\n")), 20);
      });
      rl.on("SIGINT", () => {
        const verdict = options.onSigint?.(Boolean(rl.line) || lines.length > 0) ?? "exit";
        if (verdict === "exit") return finish(null);
        if (verdict === "clear") {
          lines.length = 0;
          rl.write(null, { ctrl: true, name: "e" });
          rl.write(null, { ctrl: true, name: "u" });
        }
        output.write("\n");
        rl.setPrompt(promptStr);
        rl.prompt();
      });
      rl.on("close", () => finish(lines.length > 0 ? lines.join("\n") : null));
    });
  }

  // Piped input: one reader for the whole process. A readline per prompt
  // buffers everything already piped in and loses it on close, so a script
  // of several commands ended after the first one.
  private _piped: { lines: string[]; waiting: Array<(line: string | null) => void>; closed: boolean } | null = null;

  private _nextPipedLine(): Promise<string | null> {
    if (!this._piped) {
      const state = { lines: [] as string[], waiting: [] as Array<(line: string | null) => void>, closed: false };
      const reader = readline.createInterface({ input, terminal: false });
      reader.on("line", (line) => {
        const waiter = state.waiting.shift();
        if (waiter) waiter(line);
        else state.lines.push(line);
      });
      reader.on("close", () => {
        state.closed = true;
        for (const waiter of state.waiting.splice(0)) waiter(null);
      });
      this._piped = state;
    }
    const state = this._piped;
    if (state.lines.length > 0) return Promise.resolve(state.lines.shift()!);
    if (state.closed) return Promise.resolve(null);
    return new Promise((resolve) => state.waiting.push(resolve));
  }

  private async _pipedPrompt(promptStr: string, multiline: boolean): Promise<string | null> {
    output.write(promptStr);
    const lines: string[] = [];
    while (true) {
      const line = await this._nextPipedLine();
      if (line == null) {
        output.write("\n");
        return lines.length > 0 ? lines.join("\n") : null;
      }
      output.write(`${line}\n`);
      if (multiline && line.endsWith("\\")) {
        lines.push(line.slice(0, -1));
        continue;
      }
      lines.push(line);
      return lines.join("\n");
    }
  }

  /**
   * The main prompt. An empty line returns "" (ask again), not "exit";
   * null means the user wants out (Ctrl+D, or Ctrl+C twice).
   * End a line with \ to continue on the next; pasted lines are kept together.
   */
  async ask(promptStr = "> "): Promise<string | null> {
    console.log();
    const answer = await this._prompt(cBold(cAccent(promptStr)), {
      history: true,
      multiline: true,
      onSigint: (pending) => {
        if (pending) {
          this._lastInterrupt = 0;
          return "clear"; // drop what was typed, stay at the prompt
        }
        const now = Date.now();
        if (now - this._lastInterrupt < 2_000) return "exit";
        this._lastInterrupt = now;
        output.write(`\n  ${cMuted("(press ctrl-c again, or ctrl-d, to exit)")}`);
        return "stay";
      }
    });
    return answer == null ? null : answer.trim();
  }

  async approve(reason: string): Promise<boolean> {
    console.log();
    console.log(`  ${cBold(cTool(sanitize(reason)))}`);
    const answer = await this._prompt(cMuted("  allow? (y/n)> "), {
      onSigint: () => {
        this.onInterrupt?.();
        return "exit";
      }
    });
    return Boolean(answer?.trim().toLowerCase().startsWith("y"));
  }

  /** ask_user: a question from the agent, with optional numbered choices. */
  async question(question: string, choices?: string[]): Promise<string | null> {
    console.log();
    console.log(`  ${cBold(cAccent("agent asks"))} ${sanitize(question)}`);
    choices?.forEach((choice, i) => console.log(`    ${cMuted(`${i + 1}.`)} ${sanitize(choice)}`));
    const answer = await this._prompt(cMuted("  answer> "), {
      onSigint: () => {
        this.onInterrupt?.();
        return "exit";
      }
    });
    const n = Number(answer?.trim());
    if (choices && Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
    return answer;
  }

  note(text: string): void {
    console.log(`\n  ${cMuted(text)}`);
  }

  async pick(title: string, rows: string[]): Promise<number | null> {
    console.log(`\n  ${cBold(cAccent(title))}`);
    rows.forEach((row, i) => {
      const num = String(i).padStart(3, " ");
      console.log(`    ${cMuted(`${num}  ${row}`)}`);
    });

    const answer = await this._prompt(cMuted("\n  number> "), {});
    const num = parseInt(answer?.trim() ?? "", 10);
    return !isNaN(num) && num >= 0 && num < rows.length ? num : null;
  }

  // -------------------------------------------------------------- output

  user(text: string): void {
    console.log(`\n  ${cBold(cUser(text.trim()))}`);
  }

  agent(text: string): void {
    console.log(`\n  ${cBold(cAccent("agent"))}`);
    const formatted = formatMarkdown(sanitize(text.trim()));
    const indented = formatted
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    console.log(indented);
  }

  /** Print the model's answer as it arrives. */
  stream(chunk: string): void {
    if (!this._streaming) {
      this.stopWorking();
      console.log(`\n  ${cBold(cAccent("agent"))}`);
      output.write("    ");
      this._streaming = true;
    }
    output.write(sanitize(chunk).replace(/\n/g, "\n    "));
  }

  /** End a streamed answer. Returns whether one was in progress. */
  endStream(): boolean {
    if (!this._streaming) return false;
    output.write("\n");
    this._streaming = false;
    return true;
  }

  tool(
    name: string,
    args: Record<string, any>,
    result: string,
    nested = false
  ): void {
    if (name === "write_todos" && args.todos && Array.isArray(args.todos)) {
      return this.todos(args.todos);
    }

    const resultLines = this._format_result_lines(result);
    const paddingLeft = nested ? 6 : 2;

    if (name === "plan_task") {
      const header = `${cBold(cAccent("planner"))} ${cMuted(this._short(args.goal) || this._format_args(name, args))}`;
      console.log("\n" + renderPanel([header, "__DIVIDER__", ...resultLines], { borderColor: cAccent, paddingLeft }));
      return;
    }

    if (name === "work_task") {
      const header = `${cBold(cTool("worker"))} ${cMuted(this._format_args(name, args))}`;
      console.log("\n" + renderPanel([header, "__DIVIDER__", ...resultLines], { borderColor: cTool, paddingLeft }));
      return;
    }

    if (name === "review_task") {
      // The verdict is the first line of a structured result; text quoted
      // further down cannot flip it.
      const isApproved = result.startsWith("VERDICT: APPROVED");
      const titleColor = isApproved ? cUser : cTool;
      const verdictLabel = isApproved ? "reviewer · approved" : "reviewer · changes requested";
      const header = `${cBold(titleColor(verdictLabel))} ${cMuted(this._short(args.plan_id || args.goal) || "")}`;
      console.log("\n" + renderPanel([header, "__DIVIDER__", ...resultLines], { borderColor: titleColor, paddingLeft }));
      return;
    }

    const header = `${cBold(cTool(name))} ${cMuted(this._format_args(name, args))}`;
    console.log("\n" + renderPanel([header, "__DIVIDER__", ...resultLines], { borderColor: cBorder, paddingLeft }));
  }

  subagent(description: string): void {
    const lines = sanitize(description).trim().split("\n").map(cMuted);
    const panel = renderPanel(lines, {
      title: "subagent · own context",
      titleColor: (t) => cBold(cAccent(t)),
      borderColor: cAccent,
      paddingLeft: 4
    });
    console.log("\n" + panel);
  }

  /** One line per finished subagent: what it cost. */
  spend(label: string, spend: SpendLine): void {
    const hit = spend.promptTokens > 0 ? ` (${Math.round((spend.cachedTokens / spend.promptTokens) * 100)}% cached)` : "";
    console.log(
      `\n      ${cMuted(
        `${label} · ${spend.calls} call${spend.calls === 1 ? "" : "s"} · ` +
        `${spend.promptTokens.toLocaleString()} prompt${hit} · ${spend.completionTokens.toLocaleString()} completion · ${money(spend.cost)}`
      )}`
    );
  }

  injection(text: string): void {
    const lines = text.trim().split("\n").map(cMuted);
    const panel = renderPanel(lines, {
      title: "late injection",
      titleColor: (t) => cItalic(cMuted(t)),
      borderColor: cBorder,
      paddingLeft: 2
    });
    console.log("\n" + panel);
  }

  debug(data: any): void {
    const jsonStr = JSON.stringify(data, null, 2);
    const lines = sanitize(jsonStr).split("\n").map(cMuted);
    const panel = renderPanel(lines, {
      title: "raw response",
      titleColor: (t) => cItalic(cMuted(t)),
      borderColor: cTool,
      paddingLeft: 2
    });
    console.log("\n" + panel);
  }

  todos(todos: Array<{ content: string; status: string }>): void {
    const done = todos.filter((t) => t.status === "done").length;
    const lines: string[] = [];

    for (const todo of todos) {
      const status = todo.status || "pending";
      const mark = MARKS[status] || "○";
      const content = sanitize(String(todo.content));

      if (status === "done") {
        lines.push(`${cMuted(cStrike(`${mark} ${content}`))}`);
      } else if (status === "in_progress") {
        lines.push(`${cBold(cAccent(`${mark} ${content}`))}`);
      } else {
        lines.push(`${cMuted(`${mark} ${content}`)}`);
      }
    }

    const panel = renderPanel(lines, {
      title: `todos ${done}/${todos.length}`,
      titleColor: (t) => cBold(cTool(t)),
      borderColor: cBorder,
      paddingLeft: 2
    });

    console.log("\n" + panel);
  }

  compacted(before: number, messages: any[]): void {
    const summaryMsg = messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<summary>")
    );
    const summary = summaryMsg
      ? summaryMsg.content.replace("<summary>", "").replace("</summary>", "").trim()
      : "(no summary)";

    const formatted = formatMarkdown(sanitize(summary));
    const panel = renderPanel(formatted, {
      title: `compacted · ${before} → ${messages.length} messages`,
      titleColor: (t) => cBold(cTool(t)),
      borderColor: cTool,
      paddingLeft: 2
    });

    console.log("\n" + panel);
  }

  // -------------------------------------------------------------- spinner

  working(label = "thinking"): { stop: () => void } {
    this.stopWorking();

    const isTTY = Boolean(process.stdout.isTTY);
    if (!isTTY || this._streaming) {
      return { stop: () => {} };
    }

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;

    process.stdout.write(`  ${cAccent(frames[0])} ${cMuted(label)}`);

    this._spinnerInterval = setInterval(() => {
      i = (i + 1) % frames.length;
      process.stdout.write(`\r  ${cAccent(frames[i])} ${cMuted(label)}`);
    }, 80);

    const stop = () => {
      this.stopWorking();
    };

    return { stop };
  }

  stopWorking(): void {
    if (this._spinnerInterval) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = null;
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[2K");
      }
    }
  }

  // -------------------------------------------------------------- usage & summary

  usage(stats: Record<string, number | null | undefined>, indent = 2): void {
    for (const [key, value] of Object.entries(stats)) {
      if (value != null) {
        this._totals[key] = (this._totals[key] || 0) + value;
      }
    }

    const parts: string[] = [];
    for (const [key, value] of Object.entries(stats)) {
      if (value != null && value > 0) {
        const cleanKey = key.replace(/_tokens$/, "").replace(/_/g, " ");
        parts.push(`${value.toLocaleString()} ${cleanKey}`);
      }
    }

    if (parts.length > 0) {
      console.log(`\n${" ".repeat(indent)}${cMuted(parts.join("  ·  "))}`);
    }
  }

  summary(extraMetrics?: {
    e2eSpeed?: string;
    generationSpeed?: string;
    ttft?: string;
    totalCost?: string;
    cacheHit?: string;
    byRole?: string;
  }): void {
    console.log();
    const rows: Array<{ label: string; value: string }> = [];

    for (const [key, value] of Object.entries(this._totals)) {
      if (value > 0) {
        rows.push({
          label: key.replace(/_/g, " "),
          value: value.toLocaleString()
        });
      }
    }
    // per turn: the next summary starts from zero
    this._totals = {};

    if (extraMetrics) {
      if (extraMetrics.cacheHit) {
        rows.push({ label: "cache hit (main)", value: extraMetrics.cacheHit });
      }
      if (extraMetrics.ttft) {
        rows.push({ label: "time to first token", value: extraMetrics.ttft });
      }
      if (extraMetrics.generationSpeed) {
        rows.push({ label: "generation speed", value: extraMetrics.generationSpeed });
      }
      if (extraMetrics.e2eSpeed) {
        rows.push({ label: "end-to-end speed", value: extraMetrics.e2eSpeed });
      }
      if (extraMetrics.totalCost) {
        rows.push({ label: "final cost", value: extraMetrics.totalCost });
      }
      if (extraMetrics.byRole) {
        rows.push({ label: "cost by role", value: extraMetrics.byRole });
      }
    }

    if (rows.length === 0) return;

    const maxLabelLen = Math.max(...rows.map((r) => r.label.length));

    for (const row of rows) {
      const paddedLabel = row.label.padEnd(maxLabelLen, " ");
      console.log(`    ${cMuted(paddedLabel)}   ${cBold(cAccent(row.value))}`);
    }

    console.log();
    console.log(renderRule(undefined, cBorder));
    console.log();
  }

  replay(messages: any[]): void {
    const results = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        results.set(m.toolCallId, m.content || "");
      }
    }

    for (const message of messages) {
      if (message.role === "user") {
        if (typeof message.content === "string" && message.content.startsWith("<summary>")) {
          this.compacted(messages.length, [message]);
        } else {
          this.user(String(message.content ?? ""));
        }
      } else if (message.role === "assistant") {
        if (message.content) {
          this.agent(message.content);
        }
        for (const call of message.toolCalls || []) {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {}
          this.tool(
            call.function.name,
            args,
            results.get(call.id) || ""
          );
        }
      }
    }
  }

  // -------------------------------------------------------------- helpers

  private _short(value: unknown, max = 160): string {
    if (value == null) return "";
    const text = sanitize(typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  /** Headline arguments: a path and a size for edits, not the whole file. */
  private _format_args(name: string, args: Record<string, any>): string {
    const size = (v: unknown) => (typeof v === "string" ? `${v.length.toLocaleString()} chars` : "?");
    if (name === "write_file") {
      return `${this._short(args.path)} (${size(args.content)})`;
    }
    if (name === "str_replace" || name === "string_replace") {
      return `${this._short(args.path)} (${size(args.old_str)} → ${size(args.new_str)})`;
    }
    if (name === "work_task") {
      return [args.plan_id, args.plan ? `plan ${size(args.plan)}` : "", this._short(args.instructions, 100)]
        .filter(Boolean)
        .join(" · ");
    }
    const keys = Object.keys(args);
    if (keys.length === 1) {
      return this._short(args[keys[0]], 300);
    }
    return this._short(args, 300);
  }

  private _format_result_lines(result: string): string[] {
    const rawLines = sanitize(result).trim().split(/\r?\n/);
    const lines = rawLines.length > 0 && rawLines[0] !== "" ? rawLines : ["(no output)"];
    const shown = lines.slice(0, MAX_TOOL_OUTPUT_LINES);

    const formattedLines: string[] = shown.map((l) => cMuted(l));

    const hidden = lines.length - shown.length;
    if (hidden > 0) {
      formattedLines.push(cItalic(cTool(`… ${hidden} more lines`)));
    }

    return formattedLines;
  }
}

export const ui = new UI();
