/**
 * Swissyphus Connector SDK core (RFP §6.1).
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
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<CallToolResult>;
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
}
