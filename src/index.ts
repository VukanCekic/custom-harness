import fs from "node:fs";
import path from "node:path";
import type { ChatMessages } from "@openrouter/sdk/models";
import { config, getSystemPrompt, type Mode } from "./config.js";
import { runAgent, budgetWarning, overhead } from "./agent.js";
import { saveRunResult } from "./recorder.js";
import { ui } from "./ui.js";
import { closeBrowser } from "./tools/browser.js";
import { activeForm } from "./todos.js";
import * as sandbox from "./sandbox.js";
import { compact } from "./compact.js";
import { resetContextState } from "./context.js";
import { resetPermissions } from "./permissions.js";
import { resetPipeline } from "./pipeline.js";
import { settle, sweep, HANDOFF_OPENING } from "./history.js";
import { usesBreakpoints, type Spend } from "./llm.js";
import { blame, forget } from "./cache.js";
import { CancelledError } from "./scope.js";
import { Session, legacyTranscript, listSessions, load, sessionDir } from "./session.js";

const HELP = `Commands:
    /clear      - Start a new session (history, todos and plans cleared, browser closed)
    /compact    - Summarise the conversation so far to free up context
    /rewind     - Go back to before one of your earlier messages
    /sessions   - Switch to an earlier session of this project
    /pipeline   - Toggle pipeline mode (/pipeline on|off): plan -> work -> review only
    /exit       - Quit (or ctrl-d)
    /help       - Show this help

Input: end a line with \\ to continue on the next. ctrl-c cancels a running turn;
press it twice at the prompt (or ctrl-d) to quit.`;

const HISTORY_FILE = () => path.join(sessionDir(), "input_history.json");

function loadInputHistory(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE(), "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((h) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

function saveInputHistory(): void {
  try {
    fs.mkdirSync(sessionDir(), { recursive: true });
    fs.writeFileSync(HISTORY_FILE(), JSON.stringify(ui.history.slice(0, 1000)), "utf-8");
  } catch {
    // history is a convenience; never fail a prompt over it
  }
}

function formatRoles(byRole: Partial<Record<string, Spend>>): string | undefined {
  const parts = Object.entries(byRole)
    .filter(([, spend]) => spend && spend.calls > 0)
    .map(([role, spend]) => `${role} $${spend!.cost.toFixed(6)}`);
  return parts.length > 1 ? parts.join(" · ") : undefined;
}

// ------------------------------------------------------------------ state

let mode: Mode = "default";
let session: Session;
let sessionMessages: ChatMessages[] = [];
let debug = false;
let streaming = true;

/** The running turn, if any. Ctrl+C aborts it; a second Ctrl+C quits. */
let turn: AbortController | null = null;
let shuttingDown = false;

async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    ui.stopWorking();
    ui.endStream();
    sweep(); // spilled tool output of the interrupted turn
    saveInputHistory();
    await closeBrowser();
  }
  process.exit(code);
}

function cancelTurn(): boolean {
  if (!turn || turn.signal.aborted) return false;
  turn.abort(new CancelledError());
  return true;
}

process.on("SIGINT", () => {
  if (cancelTurn()) {
    ui.stopWorking();
    ui.endStream();
    ui.note("cancelling the turn... (ctrl-c again to quit)");
    return;
  }
  void shutdown(130);
});
ui.onInterrupt = () => {
  cancelTurn();
};

function freshTranscript(): ChatMessages[] {
  return [{ role: "system", content: getSystemPrompt(mode) }];
}

function adopt(messages: ChatMessages[]): ChatMessages[] {
  // Finished turns are stripped as they would have been when they ended.
  settle(messages, overhead());
  return messages;
}

// ------------------------------------------------------------------ one turn

async function runTurn(promptText: string): Promise<void> {
  ui.user(promptText);

  let spinner = ui.working(`${activeForm()}...`);
  const restart = () => {
    spinner = ui.working(`${activeForm()}...`);
  };
  const pause = () => {
    spinner.stop();
    ui.endStream();
  };

  turn = new AbortController();
  try {
    const result = await runAgent(promptText, {
      messages: sessionMessages,
      mode,
      signal: turn.signal,
      onTranscript: (messages) => session.sync(messages),
      onChunk: streaming
        ? (chunk) => {
            spinner.stop();
            ui.stream(chunk);
          }
        : undefined,
      // Runs autonomously until the agent completes all tool actions
      onToolCall: (toolName) => {
        pause();
        spinner = ui.working(`running ${toolName}...`);
      },
      onToolExecution: (toolName, args, toolResult) => {
        spinner.stop();
        ui.tool(toolName, args, toolResult);
        restart();
      },
      onApprove: async (reason) => {
        pause();
        const approved = await ui.approve(reason);
        restart();
        return approved;
      },
      onAsk: async (question, choices) => {
        pause();
        const answer = await ui.question(question, choices);
        restart();
        return answer;
      },
      onAssistantMessage: (assistantMsg) => {
        if (debug) {
          pause();
          ui.debug(assistantMsg);
          restart();
        }
      },
      onInjection: (content) => {
        if (debug || content.includes("<system-reminder>")) {
          spinner.stop();
          ui.injection(content);
          restart();
        }
      },
      onMessage: (content) => {
        spinner.stop();
        if (!ui.endStream()) ui.agent(content);
        restart();
      },
      onCompacted: (before, compactedMessages) => {
        spinner.stop();
        ui.compacted(before, compactedMessages);
        restart();
      },
      onCacheBreak: (info) => {
        if (debug) {
          spinner.stop();
          ui.note(
            `cache: prefix rebuilt from message ${info.at} of ${info.of} ` +
            `(${Math.round(info.reused * 100)}% of the previous request reused) - ${info.reason}`
          );
          restart();
        }
      },
      onNote: (text) => {
        pause();
        ui.note(text);
        restart();
      },
      onStepEnd: (_step, usage) => {
        if (usage) {
          pause();
          ui.usage({
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cached_tokens: usage.cached_tokens
          });
          restart();
        }
      }
    });

    pause();
    if (result.cancelled) ui.note("turn cancelled - the transcript is intact; say what to do next.");

    const m = result.lastMetrics;
    ui.summary({
      ttft: m?.time_to_first_token_ms != null ? `${m.time_to_first_token_ms}ms` : undefined,
      generationSpeed: m?.generation_tokens_per_second != null ? `${m.generation_tokens_per_second} tokens/sec` : undefined,
      e2eSpeed: m?.e2e_tokens_per_second != null ? `${m.e2e_tokens_per_second} tokens/sec` : undefined,
      totalCost: `$${result.totalCost.toFixed(6)}`,
      cacheHit: result.cacheHitRate != null ? `${Math.round(result.cacheHitRate * 100)}%` : undefined,
      byRole: formatRoles(result.costByRole)
    });

    const telemetry = {
      prompt: promptText,
      model: config.model,
      mode: result.mode,
      steps: result.steps,
      cancelled: result.cancelled,
      cost: result.totalCost,
      cost_by_role: result.costByRole,
      cache_hit_rate: result.cacheHitRate,
      cache_breaks: result.cacheBreaks,
      compactions: result.compactions,
      step_usage: result.stepUsage
    };
    session.turn(telemetry);

    // Full details (transcript, metrics, usages) next to the session log
    try {
      const savedPath = await saveRunResult({
        session: session.id,
        ...telemetry,
        final_response: result.finalResponse,
        usage: result.lastUsage ? { ...result.lastUsage, cost: result.totalCost } : null,
        metrics: result.lastMetrics,
        transcript: result.messages
      });
      if (debug) ui.note(`Saved details to: ${savedPath}`);
    } catch (err: any) {
      ui.note(`Failed to save run details: ${err.message}`);
    }
  } catch (err: any) {
    pause();
    ui.note(`Execution error: ${err.message || String(err)}`);
  } finally {
    turn = null;
  }
}

// ------------------------------------------------------------------ commands

async function rewind(): Promise<void> {
  const points = sessionMessages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(HANDOFF_OPENING));
  if (points.length === 0) {
    ui.note("Nothing to rewind to.");
    return;
  }
  const rows = points.map(({ m }) => String(m.content).replace(/\s+/g, " ").slice(0, 70));
  const choice = await ui.pick("rewind to before which message?", rows);
  if (choice == null) {
    ui.note("Rewind cancelled.");
    return;
  }
  const keep = points[choice].index;
  blame(sessionMessages, "rewind");
  sessionMessages.splice(keep);
  session.rewind(keep);
  ui.note(`Rewound to before: ${rows[choice]} (${sessionMessages.length} messages left). Files on disk are not changed.`);
}

async function switchSession(): Promise<void> {
  const sessions = listSessions().filter((s) => s.file !== session.file);
  if (sessions.length === 0) {
    ui.note("No other sessions for this project.");
    return;
  }
  const rows = sessions.map(
    (s) => `${s.modified.toLocaleString()}  ${String(s.messages).padStart(4)} msgs  ${s.firstRequest.replace(/\s+/g, " ").slice(0, 50)}`
  );
  const choice = await ui.pick("switch to which session?", rows);
  if (choice == null) {
    ui.note("Staying in this session.");
    return;
  }
  const loaded = load(sessions[choice].file);
  if (loaded.messages.length === 0) {
    ui.note("That session is empty.");
    return;
  }
  await closeBrowser();
  resetContextState();
  resetPipeline();
  forget(sessionMessages);
  sessionMessages = adopt(loaded.messages);
  session = Session.resume(sessions[choice].file, sessionMessages);
  ui.resumed(sessionMessages, `switched to ${session.id}`);
  ui.replay(sessionMessages);
}

function setMode(next: Mode): void {
  if (next === mode) {
    ui.note(`Already in ${mode} mode.`);
    return;
  }
  mode = next;
  // The system prompt describes the mode, so it changes too: one cache rebuild.
  blame(sessionMessages, "mode");
  sessionMessages[0] = { role: "system", content: getSystemPrompt(mode) };
  session.replace(sessionMessages, "mode");
  ui.note(
    mode === "pipeline"
      ? "Pipeline mode on: the agent plans, dispatches the worker and reviews; it does not edit files itself."
      : "Pipeline mode off: the agent codes directly again."
  );
}

/** "exit" ends the REPL; "prompt" means it was not a command after all. */
async function command(input: string): Promise<"done" | "exit" | "prompt"> {
  const [cmd, arg] = input.trim().toLowerCase().split(/\s+/);
  switch (cmd) {
    case "/exit":
    case "/quit":
      return "exit";
    case "/clear":
    case "/new":
    case "/reset":
      await closeBrowser();
      resetContextState();
      resetPermissions();
      resetPipeline();
      forget(sessionMessages);
      sessionMessages = freshTranscript();
      session = Session.create();
      session.sync(sessionMessages);
      ui.note("New session started. History, todos and plans cleared; browser closed.");
      return "done";
    case "/compact": {
      const before = sessionMessages.length;
      const spinner = ui.working("compacting transcript...");
      try {
        blame(sessionMessages, "compaction");
        // forced: works on a short transcript too, keeping only the newest exchange verbatim
        await compact(sessionMessages, true);
        spinner.stop();
        if (sessionMessages.length < before) {
          session.replace(sessionMessages, "compaction");
          ui.compacted(before, sessionMessages);
        } else {
          ui.note("Nothing to compact yet.");
        }
      } catch (err: any) {
        spinner.stop();
        ui.note(`Compaction failed: ${err.message || String(err)}`);
      }
      return "done";
    }
    case "/rewind":
      await rewind();
      return "done";
    case "/sessions":
      await switchSession();
      return "done";
    case "/pipeline":
      setMode(arg === "off" ? "default" : arg === "on" ? "pipeline" : mode === "pipeline" ? "default" : "pipeline");
      return "done";
    case "/help":
      ui.note(HELP);
      return "done";
    default:
      return "prompt"; // e.g. a message that starts with a path
  }
}

// ------------------------------------------------------------------ main

async function main() {
  if (!config.apiKey) {
    ui.note("Error: OPENROUTER_API_KEY is not set in your .env file.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const isResume = args.includes("--resume");
  debug = args.includes("--debug");
  streaming = Boolean(process.stdout.isTTY) && !args.includes("--no-stream") && process.env.STREAM !== "0";
  if (args.includes("--pipeline")) mode = "pipeline";
  const cliPrompt = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  ui.banner(sandbox.name(), config.model, [
    `cache: ${usesBreakpoints() ? "anthropic breakpoints" : "provider automatic"}`,
    mode === "pipeline" ? "mode: pipeline" : null
  ].filter((x): x is string => Boolean(x)));
  ui.history = loadInputHistory();

  sessionMessages = freshTranscript();
  const warning = budgetWarning(sessionMessages[0].content as string);
  if (warning) ui.note(`warning: ${warning}`);

  const latest = isResume ? listSessions().find((s) => s.messages > 0) : undefined;
  if (latest) {
    // continue the old log rather than opening a new one
    sessionMessages = adopt(load(latest.file).messages);
    session = Session.resume(latest.file, sessionMessages);
    ui.resumed(sessionMessages, `resumed ${session.id}`);
    ui.replay(sessionMessages);
  } else {
    session = Session.create();
    const legacy = isResume ? legacyTranscript() : null;
    if (legacy) {
      sessionMessages = adopt(legacy);
      session.replace(sessionMessages, "imported from test/");
      ui.resumed(sessionMessages, "resumed (imported from test/)");
      ui.replay(sessionMessages);
    } else if (isResume) {
      ui.note("No past session found to resume.");
    }
  }
  session.sync(sessionMessages);

  try {
    if (cliPrompt) {
      await runTurn(cliPrompt);
      return;
    }

    // Interactive mode: maintains conversation history across prompts
    while (true) {
      const userInput = await ui.ask();
      if (userInput == null) break; // ctrl-d, or ctrl-c twice
      saveInputHistory();
      if (!userInput) continue; // an empty line is not "exit"

      if (userInput.startsWith("/")) {
        const handled = await command(userInput);
        if (handled === "exit") break;
        if (handled === "done") continue;
      }

      await runTurn(userInput);
    }
  } finally {
    saveInputHistory();
    await closeBrowser();
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    await closeBrowser();
    console.error("\nFatal error:", err);
    process.exit(1);
  });
