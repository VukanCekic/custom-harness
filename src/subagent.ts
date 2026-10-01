import type { Tool } from "./tools/types.js";
import type { ChatFunctionTool, ChatMessages } from "@openrouter/sdk/models";
import { callLLM, spentSince, tally } from "./llm.js";
import { cap, fit, sweep, type SpillScope } from "./history.js";
import { approver, execute, type Gate } from "./execute.js";
import { current, within, type Role } from "./scope.js";
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
 */
export async function runSubagent(subagentConfig: SubagentConfig): Promise<string> {
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

  const loop = async (): Promise<string> => {
    for (let turn = 1; turn <= maxTurns; turn++) {
      spinner.stop();
      spinner = ui.working(`${label} working (turn ${turn}/${maxTurns})...`);

      if (!fit(messages, budget, fixed, spills).fits) {
        report ||= `(${label} ran out of context window before it could report.)`;
        break;
      }

      const { message, usage } = await callLLM(messages, toolSchemas);

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
        return report || `${label} completed with no output.`;
      }

      let finished = false;
      for (const toolCall of message.toolCalls) {
        if (finished) {
          // the run is over; answer the remaining calls so the transcript stays valid
          messages.push({ role: "tool", toolCallId: toolCall.id, content: "[not run: the report was already submitted]" });
          continue;
        }
        spinner.stop();
        spinner = ui.working(`${label}: running ${toolCall.function.name}...`);

        const { args, result } = await execute(toolCall, gate);
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
      if (finished) return report;
    }

    // Out of turns. Ask once more, for the report only: the last thing it
    // said is usually "let me check one more file", not a finding.
    messages.push({
      role: "user",
      content: "You are out of turns. Reply now with your report - what you found, what you changed, what is unfinished. Do not call any tools."
    });
    try {
      if (fit(messages, budget, fixed, spills).fits) {
        const { message } = await callLLM(messages, toolSchemas);
        if (message.content) report = message.content;
      }
    } catch {
      // keep the last thing it managed to say
    }

    return report
      ? `(stopped after ${maxTurns} turns, before finishing. Partial findings below - narrow the question and ask again.)\n\n${report}`
      : `(stopped after ${maxTurns} turns with nothing to report.)`;
  };

  try {
    return await within({ role, signal }, loop);
  } catch (err: any) {
    // Files the worker already changed stay changed, so the parent needs to
    // know what the tree looks like now, not just that something went wrong.
    const why = parent?.aborted
      ? "was cancelled by the user"
      : deadline.aborted
        ? `ran out of time (${Math.round(timeoutMs / 1000)}s)`
        : `failed: ${err?.message || String(err)}`;
    const status = await shortStatus();
    return [
      `(${label} ${why} before finishing.)`,
      report ? `Last thing it reported:\n${report}` : "",
      `Working tree now (git status --short):\n${status || "(clean, or not a git repository)"}`
    ].filter(Boolean).join("\n\n");
  } finally {
    spinner.stop();
    sweep(spills);
    const spend = spentSince(spentBefore)[role];
    if (spend) ui.spend(label, spend);
  }
}
