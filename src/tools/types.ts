import type { ChatFunctionTool } from "@openrouter/sdk/models";

/**
 * Standard interface for any tool registered in the agent harness.
 */
export interface Tool<TArgs = any, TResult = any> {
  name: string;
  schema: ChatFunctionTool;
  execute: (args: TArgs) => Promise<TResult> | TResult;
}
