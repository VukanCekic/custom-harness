import type { Tool } from "./types.js";
import { asker } from "../execute.js";

export interface AskUserArgs {
  question: string;
  choices?: string[];
}

/**
 * A clarifying question in the middle of a turn. Without it the only way to
 * ask was to end the turn - which is how a handoff note once said "re-ask
 * the user" and the agent had no way to do it.
 */
export const askUserTool: Tool<AskUserArgs, string> = {
  name: "ask_user",
  schema: {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a short clarifying question and wait for the answer. Use it only when the task is " +
        "genuinely ambiguous and a wrong guess would be costly - not to confirm things you can check yourself.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "One clear question" },
          choices: {
            type: "array",
            items: { type: "string" },
            description: "Optional suggested answers; the user may still type their own"
          }
        },
        required: ["question"]
      }
    }
  },
  execute: async ({ question, choices }) => {
    if (typeof question !== "string" || !question.trim()) return "Error: question must be a non-empty string.";
    const ask = asker.getStore();
    if (!ask) {
      return "No user is available to answer here. Make the most reasonable assumption, state it, and carry on.";
    }
    const answer = await ask(question.trim(), Array.isArray(choices) ? choices.map(String) : undefined);
    return answer?.trim() ? `The user answered: ${answer.trim()}` : "The user did not answer. Make the most reasonable assumption and state it.";
  }
};
