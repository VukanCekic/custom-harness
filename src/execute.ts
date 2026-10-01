/**
 * Running one tool call.
 *
 * Shared by the main loop and every subagent, so a subagent is fenced in by
 * exactly the same permission rules - it is a second caller, not a privileged
 * one, and not a way around any of them.
 *
 * A tool call is text the model wrote, so all of it is untrusted: the name may
 * not exist and the arguments may not be JSON. Each of those comes back as a
 * result the model can read and retry. None of them is run with whatever
 * happened to parse, and none of them ends the session.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatToolCall } from "@openrouter/sdk/models";
import type { Tool } from "./tools/types.js";
import { check } from "./permissions.js";

export type Approver = (reason: string) => Promise<boolean>;

/**
 * The human in the loop for whichever agent is running right now. The main
 * loop sets it around each tool call, so a subagent started from inside one
 * inherits it and its risky commands reach the same prompt.
 */
export const approver = new AsyncLocalStorage<Approver | undefined>();

/** Puts a question to the user and returns their answer, or null if they gave none. */
export type Asker = (question: string, choices?: string[]) => Promise<string | null>;

/** Only the main loop sets this. A subagent cannot interrupt the user. */
export const asker = new AsyncLocalStorage<Asker | undefined>();

export interface Gate {
  tools: Record<string, Tool>;
  approve?: Approver; // absent: anything that needs asking is refused
}

export interface Executed {
  args: Record<string, any>;
  result: string;
}

/** Best-effort parse, for callbacks that only display the arguments. */
export function peek(raw: string | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The reply hit the output-token limit, so its last call is cut off. The
 * generic "not valid JSON - send the complete call again" made the model
 * resend the same oversized call until the step limit, paying for the output
 * each time. Returns the result to record instead of running it, or null if
 * this call arrived whole.
 */
export function cutOff(call: ChatToolCall): string | null {
  try {
    JSON.parse(call.function.arguments || "{}");
    return null;
  } catch {
    return (
      `Error: your reply hit the output-token limit and this ${call.function.name} call was cut off, so nothing was run. ` +
      "Sending it again will be cut off the same way. Make it smaller: write a long file in parts " +
      "(write_file with the first part, then str_replace to add the rest), or split the work into several calls."
    );
  }
}

export async function execute(call: ChatToolCall, gate: Gate): Promise<Executed> {
  const name = call.function.name;

  let args: Record<string, any>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch (err: any) {
    // Usually a response cut off mid-call. Running the tool with {} instead
    // produced errors about "undefined" paths that never told the model why.
    return {
      args: {},
      result: `Error: the arguments for ${name} were not valid JSON (${err.message}). Nothing was run - send the complete call again.`
    };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { args: {}, result: `Error: the arguments for ${name} must be a JSON object. Nothing was run.` };
  }

  const tool = gate.tools[name];
  if (!tool) {
    return {
      args,
      result: `Error: there is no tool named "${name}" here. Available: ${Object.keys(gate.tools).join(", ")}.`
    };
  }

  // A caller that cannot ask is read-only: stricter rules, see check().
  const permission = check(name, args, { strict: !gate.approve });
  const reason = permission.reason || name;
  if (permission.action === "deny") {
    return { args, result: `Permission denied: ${reason} is blocked by security policy.` };
  }
  if (permission.action === "ask") {
    if (!gate.approve) {
      return {
        args,
        result: `Permission denied: ${reason} needs a human to approve it, and this agent cannot ask. Use a read-only command instead.`
      };
    }
    if (!(await gate.approve(reason))) {
      return { args, result: `Permission denied by user for ${reason}.` };
    }
    permission.remember?.();
  }

  try {
    const raw = await tool.execute(args);
    return { args, result: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) };
  } catch (err: any) {
    return { args, result: `Tool error: ${err.message || String(err)}` };
  }
}
