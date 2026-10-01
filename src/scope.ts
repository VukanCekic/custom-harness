/**
 * What the code running right now belongs to.
 *
 * Carried in async context rather than passed by hand, so a tool started by
 * the main loop - and a subagent started by that tool, and the bash command
 * that subagent runs - all see the same cancel signal without every function
 * in between growing a parameter for it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Who an LLM call is billed to in the ledger and the run record. */
export type Role = "main" | "planner" | "worker" | "reviewer" | "researcher" | "compaction";

export interface Scope {
  role: Role;
  /** Aborted when the user presses Ctrl+C, or a subagent runs out of time. */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<Scope>();

export function current(): Scope {
  return storage.getStore() ?? { role: "main" };
}

/** Run `fn` with part of the scope replaced; the rest is inherited. */
export function within<T>(patch: Partial<Scope>, fn: () => T): T {
  return storage.run({ ...current(), ...patch }, fn);
}

/** Thrown when the user cancelled the turn. The transcript is left valid. */
export class CancelledError extends Error {
  name = "CancelledError";
  constructor(message = "cancelled by user") {
    super(message);
  }
}

/** True when this abort came from the user, not from a timeout or a stall. */
export function cancelledByUser(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted && signal.reason instanceof CancelledError);
}
