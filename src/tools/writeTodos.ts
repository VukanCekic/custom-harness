import type { Tool } from "./types.js";
import { writeTodos, type TodoItem } from "../todos.js";

export interface WriteTodosArgs {
  todos: TodoItem[];
}

/**
 * Tool for recording and updating the plan for multi-step tasks.
 */
export const writeTodosTool: Tool<WriteTodosArgs, string> = {
  name: "write_todos",
  schema: {
    type: "function",
    function: {
      name: "write_todos",
      description:
        "Record the plan for a multi-step task. Send the whole list every time. Keep exactly one task in_progress and update it as you go.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "The task, imperative: 'Fix the parser'"
                },
                activeForm: {
                  type: "string",
                  description: "Present continuous: 'Fixing the parser'"
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "done"]
                }
              },
              required: ["content", "activeForm", "status"]
            }
          }
        },
        required: ["todos"]
      }
    }
  },
  execute: async ({ todos }) => {
    return writeTodos(todos || []);
  }
};
