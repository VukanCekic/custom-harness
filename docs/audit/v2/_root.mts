/**
 * Which checkout a probe runs against: $HARNESS_ROOT, or the repository this
 * file lives in (docs/audit/v2 -> three levels up). Every probe imports the
 * real modules from there; none of them calls a real API.
 *
 *   npx tsx docs/audit/v2/p1-permissions.mts                       # this checkout
 *   HARNESS_ROOT=/path/to/patched npx tsx docs/audit/v2/p1-permissions.mts
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = process.env.HARNESS_ROOT
  ? path.resolve(process.env.HARNESS_ROOT)
  : path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** file:// URL of a module in the checkout, e.g. at("src/history.ts"). */
export const at = (relative: string): string => pathToFileURL(path.join(ROOT, relative)).href;

/** Never send anything anywhere: a key the provider would reject, set before config.ts reads .env. */
export function offline(): void {
  process.env.OPENROUTER_API_KEY = "sk-or-probe-never-sent";
}
