/**
 * Single entry point for running a tool handler, shared by the MCP server and
 * the REST API: applies the per-call time budget and emits debug timings.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "./module.js";
import { debugLog, withTimeBudget } from "./http.js";

/** Wall-clock ceiling for one tool call's upstream work (SWISSYPHUS_TOOL_BUDGET_MS, default 30 s). */
export const TOOL_BUDGET_MS = Number(process.env["SWISSYPHUS_TOOL_BUDGET_MS"]) || 30_000;

export async function invokeTool(t: ToolDef, args: Record<string, unknown>): Promise<CallToolResult> {
  const started = Date.now();
  let isError: boolean | undefined;
  try {
    const res = await withTimeBudget(TOOL_BUDGET_MS, () => t.handler(args));
    isError = res.isError;
    return res;
  } finally {
    debugLog(`tool ${t.name} ${isError ? "ERROR " : ""}in ${Date.now() - started} ms`);
  }
}
