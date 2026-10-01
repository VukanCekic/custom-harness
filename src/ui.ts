/**
 * Terminal presentation layer.
 *
 * Knows nothing about LLMs, providers or tools - it only receives plain strings
 * and dicts and decides how they look.
 * Modeled after rich terminal UI with Tokyo Night palette.
 */

import readline from "node:readline/promises";
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
const ANSI_DIM = "\x1b[2m";
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

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
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
  const targetWidth = Math.min(termWidth - 4, options.width || 88);
  const padLeft = options.paddingLeft ?? 2;
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

  // Content body
  for (const rawLine of contentLines) {
    // If it's a divider rule inside the panel
    if (rawLine === "__DIVIDER__") {
      lines.push(
        padPrefix + bCol("├" + "─".repeat(targetWidth - 2) + "┤")
      );
      continue;
    }

    const vLen = visibleLength(rawLine);
    const innerWidth = targetWidth - 4; // 2 for borders, 2 for inner padding
    const paddingRight = Math.max(0, innerWidth - vLen);

    lines.push(
      padPrefix +
        bCol("│ ") +
        rawLine +
        " ".repeat(paddingRight) +
        bCol(" │")
    );
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

// ---------------------------------------------------------------- UI class

export class UI {
  private _totals: Record<string, number> = {};
  private _spinnerInterval: NodeJS.Timeout | null = null;

  // -------------------------------------------------------------- input

  banner(sandboxName = "none", modelName?: string): void {
    console.log();
    const titleText = cBold(cAccent(" custom-harness "));
    console.log(renderRule(titleText, cMuted));

    const metaParts = [
      `sandbox: ${sandboxName}`,
      modelName ? `model: ${modelName}` : null,
      "cache: enabled",
      "ctrl-c to exit"
    ].filter(Boolean);

    console.log(
      "    " + cMuted(metaParts.join("  ·  "))
    );
    console.log();
  }

  clear(): void {
    console.clear();
  }

  resumed(messages: Array<{ role: string }>, label = "resumed"): void {
    console.log(
      `  ${cMuted(`${label} · ${messages.length} messages`)}`
    );
  }

  async ask(promptStr = "> "): Promise<string> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log();
      const answer = await rl.question(cBold(cAccent(promptStr)));
      return answer.trim();
    } catch {
      console.log();
      return "";
    } finally {
      rl.close();
    }
  }

  async approve(reason: string): Promise<boolean> {
    console.log();
    console.log(`  ${cBold(cTool(reason))}`);
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(cMuted("  allow? (y/n)> "));
      return answer.trim().toLowerCase().startsWith("y");
    } catch {
      return false;
    } finally {
      rl.close();
    }
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

    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(cMuted("\n  number> "));
      const num = parseInt(answer.trim(), 10);
      return !isNaN(num) && num >= 0 && num < rows.length ? num : null;
    } catch {
      return null;
    } finally {
      rl.close();
    }
  }

  // -------------------------------------------------------------- output

  user(text: string): void {
    console.log(`\n  ${cBold(cUser(text.trim()))}`);
  }

  agent(text: string): void {
    console.log(`\n  ${cBold(cAccent("agent"))}`);
    const formatted = formatMarkdown(text.trim());
    const indented = formatted
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    console.log(indented);
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

    const formattedArgs = this._format_args(args);
    const header = `${cBold(cTool(name))} ${cMuted(formattedArgs)}`;

    const resultLines = this._format_result_lines(result);

    const content = [header, "__DIVIDER__", ...resultLines];

    const panel = renderPanel(content, {
      borderColor: cBorder,
      paddingLeft: nested ? 6 : 2
    });

    console.log("\n" + panel);
  }

  subagent(description: string): void {
    const lines = description.trim().split("\n").map(cMuted);
    const panel = renderPanel(lines, {
      title: "subagent · own context",
      titleColor: (t) => cBold(cAccent(t)),
      borderColor: cAccent,
      paddingLeft: 4
    });
    console.log("\n" + panel);
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
    const lines = jsonStr.split("\n").map(cMuted);
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

      if (status === "done") {
        lines.push(`${cMuted(cStrike(`${mark} ${todo.content}`))}`);
      } else if (status === "in_progress") {
        lines.push(`${cBold(cAccent(`${mark} ${todo.content}`))}`);
      } else {
        lines.push(`${cMuted(`${mark} ${todo.content}`)}`);
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
      (m) => typeof m.content === "string" && m.content.includes("<summary>")
    );
    const summary = summaryMsg
      ? summaryMsg.content.replace("<summary>", "").replace("</summary>", "").trim()
      : "(no summary)";

    const formatted = formatMarkdown(summary);
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
    if (!isTTY) {
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

  usage(stats: Record<string, number | null | undefined>): void {
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
      console.log(`\n  ${cMuted(parts.join("  ·  "))}`);
    }
  }

  summary(extraMetrics?: {
    e2eSpeed?: string;
    generationSpeed?: string;
    ttft?: string;
    totalCost?: string;
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

    if (extraMetrics) {
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
        this.user(message.content);
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

  private _format_args(args: Record<string, any>): string {
    const keys = Object.keys(args);
    if (keys.length === 1) {
      const val = args[keys[0]];
      return typeof val === "string" ? val : JSON.stringify(val);
    }
    return JSON.stringify(args);
  }

  private _format_result_lines(result: string): string[] {
    const rawLines = result.trim().split(/\r?\n/);
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
