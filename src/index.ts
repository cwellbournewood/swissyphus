#!/usr/bin/env node
/**
 * Swissyphus CLI entry point.
 *
 *   npx swissyphus                       start MCP server (stdio) with all modules
 *   npx swissyphus --preset outdoor      start with a preset
 *   npx swissyphus --modules a,b,c       start with specific modules
 *   npx swissyphus --list-modules        show modules, presets and tools
 *   npx swissyphus doctor                live health check of all sources
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALL_MODULES, PRESETS, resolveModules, runHealthChecks, setActiveModules } from "./registry.js";
import { buildServer, VERSION } from "./server.js";

interface CliArgs {
  modules?: string[];
  preset?: string;
  listModules: boolean;
  doctor: boolean;
  help: boolean;
  version: boolean;
  http: boolean;
  port?: number;
  discovery?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { listModules: false, doctor: false, help: false, version: false, http: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--modules":
      case "-m":
        args.modules = (argv[++i] ?? "").split(",").filter(Boolean);
        break;
      case "--preset":
      case "-p":
        args.preset = argv[++i];
        break;
      case "--list-modules":
        args.listModules = true;
        break;
      case "--discovery":
        args.discovery = true;
        break;
      case "--mode": {
        const mode = (argv[++i] ?? "").toLowerCase();
        if (mode !== "discovery" && mode !== "full") {
          console.error(`Unknown mode '${mode}'. Use 'discovery' or 'full'.\n`);
          process.exit(2);
        }
        args.discovery = mode === "discovery";
        break;
      }
      case "doctor":
      case "--doctor":
        args.doctor = true;
        break;
      case "serve":
      case "--http":
        args.http = true;
        break;
      case "--port":
        args.port = Number(argv[++i]);
        break;
      case "--stdio":
        args.http = false; // explicit stdio (default) — accepted for docker ergonomics
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        if (a?.startsWith("--modules=")) args.modules = a.slice(10).split(",").filter(Boolean);
        else if (a?.startsWith("--preset=")) args.preset = a.slice(9);
        else if (a?.startsWith("--port=")) args.port = Number(a.slice(7));
        else {
          console.error(`Unknown argument: ${a}\n`);
          args.help = true;
        }
    }
  }
  return args;
}

const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function banner(moduleCount: number, toolCount: number): string {
  return [
    "",
    `  ${RED}${BOLD}✚${RESET} ${BOLD}Swissyphus${RESET} ${DIM}v${VERSION}${RESET} — the AI gateway to Switzerland 🇨🇭`,
    `  ${DIM}${moduleCount} modules · ${toolCount} tools · zero API keys · rolling Swiss data uphill so you don't have to${RESET}`,
    "",
  ].join("\n");
}

function printHelp(): void {
  console.log(`
${BOLD}Swissyphus${RESET} v${VERSION} — zero-key MCP server for Swiss public data

${BOLD}Usage:${RESET}
  swissyphus                        start MCP server (stdio) with all modules
  swissyphus --http [--port 8000]   start HTTP mode: REST API + remote MCP + OpenAPI
  swissyphus --preset <name>        start with a preset
  swissyphus --modules <a,b,c>      start with specific modules (combinable with --preset)
  swissyphus --list-modules         list modules, tools and presets
  swissyphus --discovery            expose 3 meta-tools (search → call) instead of every schema
                                    (same as --mode discovery or SWISSYPHUS_MODE=discovery)
  swissyphus doctor                 live health check of all upstream sources

${BOLD}Presets:${RESET} ${Object.keys(PRESETS).join(", ")}

${BOLD}Claude Desktop / MCP client config:${RESET}
  { "mcpServers": { "swissyphus": { "command": "npx", "args": ["-y", "swissyphus"] } } }
`);
}

function printModules(): void {
  console.log(`\n${BOLD}Swissyphus modules${RESET} (${ALL_MODULES.length})\n`);
  for (const m of ALL_MODULES) {
    console.log(`  ${m.emoji}  ${BOLD}${m.id.padEnd(12)}${RESET} ${m.description}`);
    console.log(`      ${DIM}tools: ${m.tools.map((t) => t.name).join(", ")}${RESET}`);
  }
  console.log(`\n${BOLD}Presets${RESET}\n`);
  for (const [name, mods] of Object.entries(PRESETS)) {
    console.log(`  ${BOLD}${name.padEnd(12)}${RESET} ${DIM}${mods.join(", ")}${RESET}`);
  }
  const toolCount = ALL_MODULES.reduce((n, m) => n + m.tools.length, 0);
  console.log(`\n  ${toolCount} tools total. Combine: swissyphus --preset outdoor --modules companies\n`);
}

async function doctor(): Promise<void> {
  setActiveModules(ALL_MODULES);
  const toolCount = ALL_MODULES.reduce((n, m) => n + m.tools.length, 0);
  console.log(banner(ALL_MODULES.length, toolCount));
  console.log(`  Checking ${BOLD}upstream sources${RESET}…\n`);
  const results = await runHealthChecks();
  results.sort((a, b) => a.module.localeCompare(b.module));
  for (const r of results) {
    const mark = r.ok ? `${GREEN}●${RESET}` : `${RED}●${RESET}`;
    const latency = r.latency_ms !== undefined ? `${String(r.latency_ms).padStart(5)} ms` : "";
    const detail = r.ok ? "" : `  ${RED}${r.error ?? `HTTP ${r.http_status}`}${RESET}`;
    console.log(`  ${mark} ${r.module.padEnd(12)} ${r.source_id.padEnd(18)} ${latency}${detail}`);
  }
  const healthy = results.filter((r) => r.ok).length;
  const colour = healthy === results.length ? GREEN : RED;
  console.log(`\n  ${colour}${healthy}/${results.length} sources healthy${RESET}\n`);
  process.exit(healthy === results.length ? 0 : 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (args.listModules) {
    printModules();
    return;
  }
  if (args.doctor) {
    await doctor();
    return;
  }

  const modules = resolveModules({ modules: args.modules, preset: args.preset });
  // The flag wins over the environment; the HTTP server's per-request MCP servers read the env.
  if (args.discovery !== undefined) process.env["SWISSYPHUS_MODE"] = args.discovery ? "discovery" : "full";

  if (args.http) {
    const { startHttpServer } = await import("./http-server.js");
    const port = args.port ?? Number(process.env["PORT"] ?? 8000);
    setActiveModules(modules);
    // Throws on fatal misconfiguration or a corrupt key store; `ready` rejects
    // on listen errors (e.g. port in use). Both surface via main().catch below.
    // SIGTERM/SIGINT are handled inside (graceful drain, usage flush, exit 0).
    const http = startHttpServer(modules, port);
    await http.ready;
    return;
  }

  const server = buildServer(modules);
  const toolCount = modules.reduce((n, m) => n + m.tools.length, 0);
  // Banner goes to stderr: stdout is the MCP protocol channel.
  console.error(banner(modules.length, toolCount));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Swissyphus failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
