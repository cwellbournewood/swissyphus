/**
 * Swissyphus end-to-end smoke test.
 * Spawns the MCP server over stdio and exercises every module with live calls.
 *   node test/smoke.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASES = [
  // [tool, args, substring expected in the response text (case-insensitive)]
  ["about_swissyphus", {}, "active_modules"],
  ["list_sources", {}, "licence"],
  ["geocode", { query: "Bundesplatz 3 Bern", limit: 3 }, "wgs84"],
  ["get_elevation", { lat: 46.5583, lon: 7.8632 }, "elevation_m"],
  ["get_municipality", { lat: 47.3769, lon: 8.5417 }, "bfs_number"],
  ["get_solar_potential", { lat: 47.3763, lon: 8.5399 }, "suitability"],
  ["reverse_geocode", { lat: 46.9466, lon: 7.4443 }, "municipality"],
  ["get_elevation_profile", { points: [{ lat: 46.55, lon: 7.85 }, { lat: 46.56, lon: 7.9 }], samples: 20 }, "total_ascent_m"],
  ["convert_wgs84_to_lv95", { lat: 46.9511, lon: 7.4386 }, "lv95"],
  ["convert_lv95_to_wgs84", { easting: 2600000, northing: 1200000 }, "wgs84"],
  ["lookup_postcode", { plz: "8001" }, "locality"],
  ["search_locality", { name: "Winterthur" }, "postal_code"],
  ["get_connections", { from: "Bern", to: "Lugano", limit: 2 }, "legs"],
  ["get_departures", { station: "Zürich HB", limit: 3 }, "departures"],
  ["get_arrivals", { station: "Bern", limit: 3 }, "arrivals"],
  ["search_stations", { query: "Interlaken" }, "stations"],
  ["get_nearby_stations", { lat: 47.3769, lon: 8.5417 }, "distance_m"],
  ["search_companies", { query: "Nestlé", limit: 3 }, "uid"],
  ["get_company", { identifier: "Nestlé S.A." }, "purpose"],
  ["list_legal_forms", {}, "GmbH"],
  ["search_sogc_publications", { rubric: "HR", limit: 2 }, "publication"],
  ["get_weather", { plz: "8001" }, "forecast"],
  ["get_weather_warnings", { plz: "3920" }, "warnings"],
  ["get_current_measurements", { parameter: "temperature", near_lat: 47.37, near_lon: 8.54, limit: 3 }, "value"],
  ["list_weather_stations", { parameter: "wind" }, "stations"],
  ["get_water_data", { station_id: "2099" }, "readings"],
  ["list_hydro_stations", { query: "Aare", limit: 5 }, "station_id"],
  ["get_avalanche_bulletin", {}, "bulletin"],
  ["get_avalanche_danger_at", { lat: 46.8, lon: 9.8 }, "bulletin"],
  ["list_snow_stations", { near_lat: 46.8, near_lon: 9.8, limit: 5 }, "elevation_m"],
  ["get_snow_conditions", { top_snow: true, limit: 5 }, "snow_depth_cm"],
  ["get_recent_earthquakes", { limit: 5 }, "magnitude"],
  ["search_earthquakes", { lat: 46.2, lon: 7.5, radius_km: 100, limit: 5 }, "events"],
  ["get_exchange_rate", { currency: "EUR" }, "rate_chf"],
  ["get_exchange_rate_history", { currency: "USD", from_month: "2026-01" }, "history"],
  ["list_currencies", {}, "EUR"],
  ["get_public_holidays", { canton: "ZH" }, "holidays"],
  ["get_school_holidays", { canton: "ZH" }, "school_holidays"],
  ["is_holiday_today", { canton: "ZH", date: "2026-08-01" }, "is_holiday"],
  ["search_federal_law", { query: "Datenschutz", language: "de", limit: 5 }, "sr_number"],
  ["get_law_by_sr", { sr_number: "220" }, "in_force"],
  ["search_datasets", { query: "Mietpreisindex", limit: 3 }, "results"],
  ["get_dataset", { id: "@FROM_SEARCH@" }, "resources"],
  ["search_parliament_business", { query: "Klima", language: "DE", limit: 3 }, "results"],
  ["search_council_members", { canton: "ZH", limit: 5 }, "members"],
  ["check_source_health", { module: "weather" }, "healthy"],
  // --- v0.2 expansion ---
  ["get_weather_history", { station_code: "SMA", date_from: DAYS_AGO(3), parameter: "temperature" }, "series"],
  ["get_pollen", { taxon: "graeser", near_lat: 47.37, near_lon: 8.54, limit: 3 }, "concentration"],
  ["get_water_history", { station_id: "2099", date_from: DAYS_AGO(3), parameter: "flow" }, "series"],
  ["list_cantons", {}, "Ticino"],
  ["search_companies", { query: "garage", canton: "ZH", limit: 3 }, "uid"],
  ["track_parcel", { tracking_number: "996001261234567890" }, "tracking_url"],
  ["get_earthquake_details", { event_id: "@FROM_QUAKES@" }, "magnitude"],
  ["get_session_schedule", { limit: 3 }, "SessionName"],
  ["get_population", { canton: "Zürich" }, "population"],
  ["get_electricity_tariff", { municipality: "Baden", category: "H4" }, "total_rp_kwh"],
  ["compare_electricity_tariffs", { municipalities: ["Zürich", "Bern", "Baden"], category: "H4" }, "cheapest_first"],
  ["get_ev_chargers_nearby", { lat: 47.3769, lon: 8.5417, radius_km: 3, limit: 5 }, "plugs"],
  ["get_emergency_alerts", {}, "alert"],
  ["list_vote_dates", {}, "vote_days"],
  ["get_voting_results", { include_cantons: false }, "proposals"],
  ["get_building", { egid: "@FROM_REVGEO@" }, "egid"],
  ["get_swiss_news", { limit: 5 }, "headlines"],
  ["list_air_quality_stations", { near_lat: 47.37, near_lon: 8.54 }, "stations"],
  ["get_air_quality", { station_name: "Bern" }, "legal_limits"],
  ["query_lindas", { query: "SELECT ?name WHERE { <https://ld.admin.ch/municipality/261> <http://schema.org/name> ?name } LIMIT 5" }, "rows"],
  ["get_trail_closures", { lat: 46.6, lon: 8.6, radius_km: 40 }, "closure"],
  ["get_waste_collection", { zip: "8001", limit: 5 }, "collections"],
  ["list_waste_types", {}, "cardboard"],
  ["get_waste_calendar", { zip: "8400", days: 14 }, "calendar"],
  // Added for mcp-swiss parity (0.6)
  ["get_station_passengers", { station: "Zürich HB", years: 1 }, "avg_daily_passengers"],
  ["get_station_punctuality", { station: "Bern", worst: 2 }, "punctuality_pct"],
  ["get_station_accessibility", { station: "Bern Wankdorf" }, "step_free"],
  ["get_rail_disruptions", { active_only: false, limit: 2 }, "disruptions"],
  ["list_ogd_stations", { canton: "ZH", limit: 3 }, "abbr"],
  ["get_ogd_recent", { station: "SMA", rows: 2 }, "tre200s0"],
  ["get_ogd_history", { station: "SMA", granularity: "yearly", from: "1864-01-01", to: "1866-12-31" }, "tre200y0"],
  ["list_pollen_stations", {}, "PBE"],
  ["get_pollen_daily", { station: "PBE" }, "unit"],
  ["get_property_price_index", { provider: ["bfs"] }, "change_yoy_pct"],
  ["get_rent_index", { space: ["residential"], frequency: "annual" }, "Rental housing"],
  ["search_real_estate_data", { query: "Leerwohnungen", limit: 2 }, "results"],
  ["search_dams", { query: "Dixence", limit: 1 }, "Grande Dixence"],
  ["get_dams_by_canton", { canton: "UR", limit: 3 }, "dam_count"],
  ["get_dam_details", { name: "Contra" }, "arch dam"],
  ["get_traffic_count", { query: "Gotthard", limit: 1 }, "stations"],
  ["get_traffic_by_canton", { canton: "TI", limit: 2 }, "station_count"],
  ["get_traffic_nearby", { lat: 47.37, lon: 8.54, limit: 2 }, "distance_km"],
  ["search_parliament_speeches", { query: "Klimaschutz", limit: 1 }, "speeches"],
  ["get_politician_interests", { name: "Cédric Wermuth" }, "interests"],
  ["search_cantonal_affairs", { query: "Velo", canton: "ZH", limit: 2 }, "affairs"],
  ["get_parliamentary_documents", { query: "Budget", body: "BS", limit: 2 }, "documents"],
  ["get_committee_meetings", { body: "ZH", limit: 2 }, "meetings"],
  ["search_places", { query: "Eiger", limit: 2 }, "Grindelwald"],
  ["search_map_layers", { query: "radon", limit: 2 }, "ch.bag.radonkarte"],
  ["find_map_features", { layer: "ch.bfe.stauanlagen-bundesaufsicht", field: "damname", value: "Mauvoisin", limit: 1 }, "Mauvoisin"],
  ["search_buildings", { address: "Bundesplatz 3 Bern", limit: 1 }, "egid"],
  ["buildings_near", { lat: 46.9468, lon: 7.4442, radius_m: 50, limit: 2 }, "egid"],
  ["list_postcodes_in_canton", { canton: "ZG", limit: 3 }, "postcode_count"],
  ["search_companies_by_locality", { locality: "Zug", query: "bank", limit: 2 }, "results"],
  ["search_swiss_news", { query: "Schweiz", limit: 2 }, "headlines"],
  ["search_votes", { query: "AHV" }, "matches"],
  ["get_vote_details", { canton: "ZG", proposal: "Bundes", limit: 3 }, "municipalities"],
  ["list_avalanche_regions", {}, "region_count"],
  ["get_snow_measurements", { station: "DAV2", rows: 2 }, "snow_depth_change_24h_cm"],
  ["list_dataset_resources", { id: "leerwohnungen-nach-zimmerzahl2" }, "available_formats"],
];

function DAYS_AGO(n) {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "ignore",
});
const client = new Client({ name: "swissyphus-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools/list → ${tools.length} tools\n`);

let pass = 0;
let fail = 0;
const failures = [];
let datasetIdFromSearch = null;
let quakeEventId = null;
let egidFromRevGeo = null;

for (let [name, args, expect] of CASES) {
  const started = Date.now();
  try {
    if (name === "get_dataset" && args.id === "@FROM_SEARCH@") {
      args = { id: datasetIdFromSearch ?? "mietpreisindex" };
    }
    if (name === "get_earthquake_details" && args.event_id === "@FROM_QUAKES@") {
      args = { event_id: quakeEventId ?? "2026nbzmeg" };
    }
    if (name === "get_building" && args.egid === "@FROM_REVGEO@") {
      args = { egid: egidFromRevGeo ?? "150404" };
    }
    const res = await client.callTool({ name, arguments: args });
    const captureEnv = () => {
      try { return JSON.parse(res.content?.[0]?.text ?? "{}"); } catch { return {}; }
    };
    if (name === "search_datasets") {
      datasetIdFromSearch = captureEnv().data?.results?.[0]?.id ?? null;
    }
    if (name === "get_recent_earthquakes") {
      quakeEventId = captureEnv().data?.events?.[0]?.event_id ?? null;
    }
    if (name === "reverse_geocode") {
      egidFromRevGeo = String(captureEnv().data?.results?.[0]?.egid ?? "") || null;
    }
    const text = (res.content ?? []).map((c) => c.text ?? "").join(" ");
    const ok = !res.isError && text.toLowerCase().includes(expect.toLowerCase());
    const softOk = res.isError === undefined || res.isError === false;
    if (ok) {
      pass++;
      console.log(`  PASS  ${name} (${Date.now() - started} ms)`);
    } else {
      fail++;
      failures.push({ name, snippet: text.slice(0, 400), isError: res.isError ?? false, softOk });
      console.log(`  FAIL  ${name} (${Date.now() - started} ms)${res.isError ? " [isError]" : " [missing '" + expect + "']"}`);
    }
  } catch (err) {
    fail++;
    failures.push({ name, snippet: String(err).slice(0, 300), isError: true });
    console.log(`  FAIL  ${name} — threw: ${String(err).slice(0, 120)}`);
  }
}

console.log(`\n${pass}/${CASES.length} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n--- failure details ---");
  for (const f of failures) {
    console.log(`\n[${f.name}] isError=${f.isError}\n${f.snippet}`);
  }
}
await client.close();
process.exit(fail ? 1 : 0);
