import type { Tool } from "./tools/types.js";
import type { ChatFunctionTool, ChatMessages, ChatToolCall } from "@openrouter/sdk/models";
import { callLLM, spentSince, tally } from "./llm.js";
import { cap, fit, sweep, type SpillScope } from "./history.js";
import { approver, cutOff, execute, type Gate } from "./execute.js";
import { CancelledError, current, within, type Role } from "./scope.js";
import { shortStatus } from "./git.js";
import { ui } from "./ui.js";
import { config } from "./config.js";

export type SubagentRole = Extract<Role, "planner" | "worker" | "reviewer" | "researcher">;

export interface SubagentConfig {
  role: SubagentRole;
  taskDescription: string;
  systemPrompt: string;
  allowedTools: Tool[];
  maxTurns?: number;
  label?: string;
  /** Refuse anything the permission rules would ask about, instead of asking. */
  readOnly?: boolean;
  /** Stop as soon as this tool has run successfully - e.g. the reviewer's submit_review. */
  finishOn?: string;
  /** Wall-clock limit for the whole run. */
  timeoutMs?: number;
}

/** How a run ended. Only "done" means the text is a finished answer. */
export type SubagentStatus = "done" | "out_of_turns" | "out_of_context" | "cancelled" | "timeout" | "failed";

export interface SubagentOutcome {
  status: SubagentStatus;
  /** What the parent gets back: the report, or partial findings plus the state of the tree. */
  text: string;
}

const NOT_RUN = "[not run: the report was already submitted]";
const CANCELLED = "[cancelled before this ran]";

/**
 * Universal subagent runner with an isolated context window.
 *
 * Rules:
 * 1. "Nothing goes in": Starts with exactly two messages (role system prompt + task description).
 * 2. "Only the answer comes back": Internal tool calls/results are private; only the final text is returned.
 * 3. "Structural tool withholding": Offered only the tools explicitly permitted in `config.allowedTools`.
 * 4. "Same gate as the parent": every call goes through execute() and the permission rules. A read-only
 *    role cannot even ask; the others ask the same human the main agent does.
 * 5. Context protection: results are capped into the subagent's OWN spill scope, and the transcript is
 *    fitted every turn - its context can overflow too, and nobody compacts it.
 * 6. It always reports. Out of turns, out of time, cancelled or crashed, the parent gets what it had
 *    found so far and what the working tree looks like now - never a bare "Tool error".
 * 7. Cancelled means stopped: once the turn is cancelled or the deadline passes, no further call runs.
 */
export async function runSubagent(subagentConfig: SubagentConfig): Promise<string> {
  return (await runSubagentDetailed(subagentConfig)).text;
}

/** runSubagent, plus how the run ended - so a caller never mistakes partial notes for a result. */
export async function runSubagentDetailed(subagentConfig: SubagentConfig): Promise<SubagentOutcome> {
  const {
    role,
    taskDescription,
    systemPrompt,
    allowedTools,
    maxTurns = config.subagentMaxTurns || 15,
    label = role,
    readOnly = false,
    finishOn,
    timeoutMs = config.subagentTimeoutMs
  } = subagentConfig;

  const toolMap: Record<string, Tool> = Object.fromEntries(
    allowedTools.map((t) => [t.name, t])
  );
  const toolSchemas: ChatFunctionTool[] = allowedTools.map((t) => t.schema);
  const gate: Gate = { tools: toolMap, approve: readOnly ? undefined : approver.getStore() };
  const spills: SpillScope = [];
  const budget = config.contextWindow * config.compactAt;
  const fixed = Math.ceil(JSON.stringify(toolSchemas).length / 4);

  const parent = current().signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
  const spentBefore = tally();

  const messages: ChatMessages[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: taskDescription }
  ];

  let report = "";
  ui.subagent(`${label}: ${taskDescription.length > 400 ? `${taskDescription.slice(0, 400)}...` : taskDescription}`);
  let spinner = ui.working(`${label} working...`);

  /** Run one reply's tool calls. True once `finishOn` has run successfully. */
  const runCalls = async (calls: ChatToolCall[], truncated: boolean): Promise<boolean> => {
    let finished = false;
    for (let index = 0; index < calls.length; index++) {
      const toolCall = calls[index];
      if (finished) {
        // the run is over; answer the remaining calls so the transcript stays valid
        messages.push({ role: "tool", toolCallId: toolCall.id, content: NOT_RUN });
        continue;
      }
      // A worker used to carry on writing files after the user had cancelled.
      if (signal.aborted) {
        for (const pending of calls.slice(index)) {
          messages.push({ role: "tool", toolCallId: pending.id, content: CANCELLED });
        }
        throw signal.reason instanceof Error ? signal.reason : new CancelledError();
      }
      spinner.stop();
      spinner = ui.working(`${label}: running ${toolCall.function.name}...`);

      const cut = truncated ? cutOff(toolCall) : null;
      const { args, result } = cut ? { args: {}, result: cut } : await execute(toolCall, gate);
      const capped = cap(result, spills);

      spinner.stop();
      ui.tool(toolCall.function.name, args, capped, true);

      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: capped
      });

      if (finishOn && toolCall.function.name === finishOn && !/^(Error|Permission denied|Tool error)/.test(result)) {
        finished = true;
        report ||= result;
      }
    }
    return finished;
  };

  const partial = (why: string): string =>
    report
      ? `(${why}, before finishing. Partial findings below - narrow the question and ask again.)\n\n${report}`
      : `(${why} with nothing to report.)`;

  const loop = async (): Promise<SubagentOutcome> => {
    for (let turn = 1; turn <= maxTurns; turn++) {
      spinner.stop();
      spinner = ui.working(`${label} working (turn ${turn}/${maxTurns})...`);

      if (!fit(messages, budget, fixed, spills).fits) {
        // Said as what it is - it used to be reported as "stopped after N turns".
        return { status: "out_of_context", text: partial(`${label} ran out of context window`) };
      }

      const { message, usage, finishReason } = await callLLM(messages, toolSchemas);

      if (usage) {
        spinner.stop();
        ui.usage({
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          cached_tokens: usage.cached_tokens
        }, 6);
      }

      messages.push({
        role: "assistant",
        content: message.content || "",
        toolCalls: message.toolCalls,
        ...(message.reasoningDetails ? { reasoningDetails: message.reasoningDetails } : {})
      } as ChatMessages);

      if (message.content) {
        report = message.content;
      }

      // Subagent finished if no tool calls requested
      if (!message.toolCalls || message.toolCalls.length === 0) {
        return { status: "done", text: report || `${label} completed with no output.` };
      }

      if (await runCalls(message.toolCalls, finishReason === "length")) {
        return { status: "done", text: report };
      }
    }

    // Out of turns. Ask once more, for the report only: the last thing it
    // said is usually "let me check one more file", not a finding. A role that
    // reports through a tool is offered that tool alone and must call it -
    // told "do not call any tools", the reviewer could never deliver its
    // verdict, and no verdict counts as changes_requested.
    const reportTool = finishOn ? toolMap[finishOn]?.schema : undefined;
    messages.push({
      role: "user",
      content: reportTool
        ? `You are out of turns. Call ${finishOn} now with what you have found so far. Do not call any other tool.`
        : "You are out of turns. Reply now with your report - what you found, what you changed, what is unfinished. Do not call any tools."
    });
    try {
      if (fit(messages, budget, fixed, spills).fits) {
        const { message } = await callLLM(
          messages,
          reportTool ? [reportTool] : toolSchemas,
          reportTool ? { toolChoice: "required" } : {}
        );
        if (message.content) report = message.content;
        const calls = (message.toolCalls ?? []).filter((c) => c.function.name === finishOn);
        if (reportTool && calls.length > 0) {
          messages.push({ role: "assistant", content: message.content || "", toolCalls: calls } as ChatMessages);
          if (await runCalls(calls, false)) return { status: "done", text: report };
        }
      }
    } catch (err) {
      if (signal.aborted) throw err;
      // keep the last thing it managed to say
    }

    return { status: "out_of_turns", text: partial(`stopped after ${maxTurns} turns`) };
  };

  try {
    return await within({ role, signal }, loop);
  } catch (err: any) {
    // Files the worker already changed stay changed, so the parent needs to
    // know what the tree looks like now, not just that something went wrong.
    const status: SubagentStatus = parent?.aborted ? "cancelled" : deadline.aborted ? "timeout" : "failed";
    const why =
      status === "cancelled"
        ? "was cancelled by the user"
        : status === "timeout"
          ? `ran out of time (${Math.round(timeoutMs / 1000)}s)`
          : `failed: ${err?.message || String(err)}`;
    const tree = await shortStatus();
    return {
      status,
      text: [
        `(${label} ${why} before finishing.)`,
        report ? `Last thing it reported:\n${report}` : "",
        `Working tree now (git status --short):\n${tree || "(clean, or not a git repository)"}`
      ].filter(Boolean).join("\n\n")
    };
  } finally {
    spinner.stop();
    sweep(spills);
    const spend = spentSince(spentBefore)[role];
    if (spend) ui.spend(label, spend);
  }
}
