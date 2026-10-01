/**
 * The plan. Lives here, not in the transcript, and is re-injected every turn.
 */

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

const MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]"
};

let TODOS: TodoItem[] = [];

/**
 * Returns a copy of the current todos.
 */
export function getTodos(): TodoItem[] {
  return [...TODOS];
}

/**
 * Clears the current todos list.
 */
export function clearTodos(): void {
  TODOS = [];
}

/**
 * Replace the whole list. Exactly one task may be in_progress.
 */
export function writeTodos(todos: TodoItem[]): string {
  const active = todos.filter((t) => t.status === "in_progress");
  if (active.length > 1) {
    return `Error: ${active.length} tasks are in_progress. Only one may be.`;
  }

  TODOS = [...todos];
  return todosPrompt() || "Todo list cleared.";
}

/**
 * Formats the todo list for late prompt injection into <todos>.
 */
export function todosPrompt(): string {
  if (TODOS.length === 0) return "";
  return TODOS.map((t) => `${MARKS[t.status] || "[ ]"} ${t.content}`).join("\n");
}

/**
 * What the agent is doing right now, for the spinner label.
 */
export function activeForm(): string {
  for (const todo of TODOS) {
    if (todo.status === "in_progress") {
      return todo.activeForm;
    }
  }
  return "thinking";
}
