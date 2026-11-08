/**
 * Emit the MCP Bundle manifest (manifest.json) from the same module registry
 * that drives the MCP server — single source of truth, like the tool catalogue.
 *
 * The result is a valid `.mcpb` manifest (spec: https://github.com/anthropics/mcpb,
 * manifest_version 0.3) so Swissyphus can be packed with `npx @anthropic-ai/mcpb pack`
 * and installed into an MCPB-aware host (e.g. Claude Desktop) with a single click.
 *
 *   npm run manifest   # regenerate manifest.json
 *   npm run bundle     # manifest.json + `mcpb pack` -> swissyphus.mcpb
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ALL_MODULES, PRESETS } from "../registry.js";
import { VERSION } from "../server.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/scripts/manifest.js -> repo root
const repoRoot = resolve(here, "..", "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  description: string;
  keywords?: string[];
  engines?: { node?: string };
};

const REPO = "https://github.com/cwellbournewood/swissyphus";
const PRESET_NAMES = Object.keys(PRESETS);

const tools = ALL_MODULES.flatMap((m) =>
  m.tools.map((t) => ({ name: t.name, description: t.description })),
);

const manifest = {
  $schema: "https://raw.githubusercontent.com/anthropics/mcpb/main/dist/mcpb-manifest.schema.json",
  manifest_version: "0.3",
  name: "swissyphus",
  display_name: "Swissyphus — The AI gateway to Switzerland 🇨🇭",
  version: VERSION,
  description: pkg.description,
  long_description:
    "One MCP server for 30+ official Swiss open-data sources — companies and the SOGC " +
    "gazette, SBB timetables, punctuality and disruptions, MeteoSwiss forecasts and station " +
    "history, rivers, avalanches, snow, earthquakes, maps, buildings, real-estate indices, " +
    "federal law, federal and cantonal parliaments, vote results down to the municipality, " +
    "energy, traffic, dams and more. Zero API keys, and every response carries source " +
    "attribution, licence and freshness metadata. Runs fully locally over stdio; a discovery " +
    "mode keeps the tool list to three meta-tools.",
  author: {
    name: "Swissyphus contributors",
    url: REPO,
  },
  homepage: `${REPO}#readme`,
  documentation: `${REPO}#readme`,
  support: `${REPO}/issues`,
  repository: { type: "git", url: REPO },
  license: "MIT",
  keywords: pkg.keywords ?? [],
  privacy_policies: [`${REPO}/blob/main/PRIVACY.md`],
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js", "--preset", "${user_config.preset}"],
    },
  },
  tools,
  // Tools are declared statically above (derived from the registry), not
  // discovered at runtime by the host.
  tools_generated: false,
  user_config: {
    preset: {
      type: "string",
      title: "Module preset",
      description:
        `Which bundle of tools to load. One of: ${PRESET_NAMES.join(", ")}. ` +
        "'full' loads every module; the smaller presets save context window.",
      default: "full",
      required: false,
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: pkg.engines?.node ?? ">=20" },
  },
} as const;

const outPath = resolve(repoRoot, "manifest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `manifest.json written: ${ALL_MODULES.length} modules, ${tools.length} tools, v${VERSION}`,
);
