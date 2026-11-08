/**
 * Swissyphus Connector SDK core.
 *
 * A module bundles: an id, a description, one or more SourceManifests,
 * a set of typed tools, and optional health probes. Adding a new Swiss data
 * source means adding one file that exports an SwissyphusModule.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { HealthProbe, SourceManifest } from "./types.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/** Typed tool factory: infers the handler args from the Zod raw shape. */
export function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>;
}): ToolDef {
  return def as unknown as ToolDef;
}

export interface SwissyphusModule {
  id: string;
  emoji: string;
  title: string;
  description: string;
  sources: SourceManifest[];
  tools: ToolDef[];
  healthProbes?: HealthProbe[];
  /**
   * Optional background warm-up, run once after the HTTP server starts (never
   * in stdio mode, so a local session downloads nothing it is not asked for).
   * Use it for sources whose cold load is too slow for a tool call. Must not
   * throw; failures only mean the first call loads on demand.
   */
  warmUp?: () => Promise<void>;
}

/**
 * JSON Schema (draft-07) for a tool's input, as published in tools.schema.json,
 * the OpenAPI spec and describe_tool. Uses the input view, so parameters with
 * defaults are optional.
 */
export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  // Tool inputs are closed objects (unknown keys are stripped), as before the zod 4 migration.
  if (out["type"] === "object" && !("additionalProperties" in out)) out["additionalProperties"] = false;
  return out;
}
