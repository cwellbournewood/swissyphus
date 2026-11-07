/**
 * Swissyphus MCP server assembly: registers tools from the active modules,
 * plus MCP Resources (licence register, tool catalogue) and Prompts
 * (multi-tool Swiss workflow recipes, RFP §17).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, type JSONRPCMessage, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SwissyphusModule } from "./core/module.js";
import { toolError } from "./core/envelope.js";
import { invokeTool } from "./core/invoke.js";
import { setActiveModules } from "./registry.js";

export const VERSION = "0.5.0";

export function buildServer(modules: SwissyphusModule[]): McpServer {
  setActiveModules(modules);

  const server = new McpServer(
    { name: "swissyphus", version: VERSION },
    {
      instructions: [
        "Swissyphus — the AI gateway to Switzerland. Zero-key access to official Swiss public data:",
        modules.map((m) => `${m.id} (${m.description})`).join("; ") + ".",
        "Every response is a JSON envelope with `data`, `source` (incl. licence + attribution),",
        "`retrieved_at`, `data_as_of` and `cache_status`. Cite the attribution when presenting data to users.",
        "Coordinates are WGS84 unless stated; use the coords tools for LV95 conversion.",
        "For anything not obviously covered by a specific tool, call find_data ONCE (it searches every connected catalogue —",
        "opendata.swiss, federal geodata layers, BFS tables, LINDAS cubes, cantonal/SBB/Post portals — and returns the",
        "exact tool + arguments that fetch the data), then call the best hit's next.tool directly. If find_data returns",
        "coverage_notes saying a source is not connected, tell the user and offer the listed alternatives instead of",
        "searching further. Prefer one good call over many exploratory ones: the user is waiting.",
        "If a tool reports a source as unavailable, call check_source_health for the live status.",
      ].join(" "),
    },
  );

  for (const mod of modules) {
    for (const t of mod.tools) {
      server.registerTool(
        t.name,
        {
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        (async (args: Record<string, unknown>) => {
          try {
            return await invokeTool(t, args ?? {});
          } catch (err) {
            // Last-resort guard: a tool must never take the server down.
            return toolError(
              `Tool '${t.name}' failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
              ["Run check_source_health to see whether the upstream source is down."],
            );
          }
        }) as never,
      );
    }
  }

  registerResources(server, modules);
  registerPrompts(server, modules);
  return server;
}

/**
 * The tools/list answer for a module selection, captured once from the SDK's own
 * handler (so it is byte-for-byte what a fresh server would send).
 *
 * Why: the SDK converts every tool's Zod schema to JSON Schema on EVERY
 * tools/list call. With ~120 tools that is ~10 ms of CPU per call — the single
 * most expensive thing the stateless /mcp endpoint does, for a result that never
 * changes while the process runs.
 */
export async function snapshotToolList(modules: SwissyphusModule[]): Promise<ListToolsResult> {
  const server = buildServer(modules);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  try {
    return await new Promise<ListToolsResult>((resolve, reject) => {
      client.onmessage = (msg: JSONRPCMessage) => {
        if (!("id" in msg) || msg.id !== 1) return;
        // Round-trip through JSON: exactly what goes over the wire (drops `undefined` fields).
        if ("result" in msg) resolve(JSON.parse(JSON.stringify(msg.result)) as ListToolsResult);
        else if ("error" in msg) reject(new Error(`tools/list snapshot failed: ${msg.error.message}`));
      };
      void client
        .start()
        .then(() => client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }))
        .catch(reject);
    });
  } finally {
    await server.close();
  }
}

/** Make `server` answer tools/list from a precomputed snapshot instead of rebuilding it. */
export function useToolListSnapshot(server: McpServer, snapshot: ListToolsResult): void {
  server.server.removeRequestHandler("tools/list");
  server.server.setRequestHandler(ListToolsRequestSchema, () => snapshot);
}

function registerResources(server: McpServer, modules: SwissyphusModule[]): void {
  server.registerResource(
    "licence-register",
    "swissyphus://sources",
    {
      title: "Swissyphus licence & source register",
      description: "Machine-readable register of all data sources: operator, licence, attribution, TTLs",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            modules.flatMap((m) => m.sources.map((s) => ({ module: m.id, ...s }))),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "tool-catalogue",
    "swissyphus://catalogue",
    {
      title: "Swissyphus tool catalogue",
      description: "Machine-readable catalogue of all active tools grouped by module",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            modules.map((m) => ({
              module: m.id,
              title: m.title,
              description: m.description,
              tools: m.tools.map((t) => ({ name: t.name, description: t.description })),
            })),
            null,
            2,
          ),
        },
      ],
    }),
  );
}

function registerPrompts(server: McpServer, modules: SwissyphusModule[]): void {
  const has = (id: string) => modules.some((m) => m.id === id);

  if (has("companies")) {
    server.registerPrompt(
      "company_due_diligence",
      {
        title: "Swiss company due diligence",
        description: "Cross-source company check: register entry, gazette history, legal context",
        argsSchema: { company: z.string().describe("Company name or UID") },
      },
      ({ company }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Run a due-diligence check on the Swiss company "${company}":
1. search_companies to find it, then get_company for the full register record (UID, seat, legal form, purpose, status).
2. search_sogc_publications with the company name (rubric HR) for recent register mutations, and rubric KK to check for bankruptcy events.
3. Summarize: identity, status, recent gazette activity, red flags. Cite sources and dates from each response envelope.`,
            },
          },
        ],
      }),
    );
  }

  if (has("weather") && has("geo")) {
    server.registerPrompt(
      "address_full_report",
      {
        title: "Full report for a Swiss address",
        description: "Municipality, elevation, solar potential, weather and transport for an address",
        argsSchema: { address: z.string().describe("Swiss street address") },
      },
      ({ address }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Build a complete location report for "${address}":
1. geocode the address; keep the WGS84 coordinates and postal code.
2. get_municipality and get_elevation at those coordinates.
3. get_solar_potential for the roof.
4. get_weather for the postal code (current + warnings).
5. get_nearby_stations for public transport access.
Present a compact report with source attributions from the envelopes.`,
            },
          },
        ],
      }),
    );
  }

  if (has("avalanche") || has("snow")) {
    server.registerPrompt(
      "mountain_conditions",
      {
        title: "Mountain conditions briefing",
        description: "Avalanche danger, snow depths, weather and access for a mountain destination",
        argsSchema: { destination: z.string().describe("Mountain area or resort, e.g. 'Davos'") },
      },
      ({ destination }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Prepare a mountain conditions briefing for "${destination}":
1. geocode the destination for coordinates.
2. get_avalanche_danger_at those coordinates (state clearly if no bulletin is published).
3. list_snow_stations near the coordinates, then get_snow_conditions for the closest station.
4. get_weather for the nearest postal code, including warnings.
5. get_connections from Zürich HB as an access option.
Summarize with danger levels, snow depths and a go/no-go note. Cite data_as_of times.`,
            },
          },
        ],
      }),
    );
  }
}
