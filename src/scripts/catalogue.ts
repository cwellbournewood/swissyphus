/**
 * Emit the machine-readable tool catalogue (tools.schema.json) from the same
 * definitions that drive the MCP server — single source of truth (RFP §5.3).
 */

import { writeFileSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ALL_MODULES, PRESETS } from "../registry.js";

const catalogue = {
  name: "swissyphus",
  generated_at: new Date().toISOString(),
  modules: ALL_MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    sources: m.sources,
    tools: m.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      input_schema: zodToJsonSchema(z.object(t.inputSchema)),
    })),
  })),
  presets: PRESETS,
};

writeFileSync("tools.schema.json", JSON.stringify(catalogue, null, 2));
const toolCount = ALL_MODULES.reduce((n, m) => n + m.tools.length, 0);
console.log(`tools.schema.json written: ${ALL_MODULES.length} modules, ${toolCount} tools`);
