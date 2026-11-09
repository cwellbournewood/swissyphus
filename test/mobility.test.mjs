/**
 * Offline tests for the mobility module (sharedmobility.ch + opentransportdata.swiss).
 * Fixtures mirror the documented response shapes; globalThis.fetch is stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mobilityModule,
  classifyVehicle,
  parseIdentifyResults,
  normaliseProviders,
  parseGtfsAlerts,
  parseSiriSx,
  filterDisruptions,
  uicFromStopId,
  extractStopDelays,
  distanceM,
  indexStopDelays,
  stopDelaysFromIndex,
  clearRealtimeIndexCache,
  fitToBudget,
} from "../dist/modules/mobility.js";

const toolByName = (n) => mobilityModule.tools.find((t) => t.name === n);
const body = (res) => JSON.parse(res.content[0].text);

/** Stub fetch with a router (url, init) => {status, body}; restores afterwards. */
async function withFetch(router, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = router(u, init);
    if (!r) return new Response("not found", { status: 404 });
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

// ---------------------------------------------------------------- fixtures

const BERN = { lat: 46.9488, lon: 7.4391 };

const PROVIDERS = {
  data: {
    providers: [
      {
        provider_id: "voi",
        name: "Voi",
        vehicle_type: "E-Scooter",
        url: "https://www.voi.com",
        rental_apps: { android: { store_uri: "https://play.google.com/store/apps/details?id=io.voiapp.voi" }, ios: { store_uri: "https://apps.apple.com/app/id1395921017" } },
      },
      { provider_id: "publibike", name: "PubliBike", vehicle_type: "E-Bike,Bike", url: "https://www.publibike.ch" },
      { provider_id: "mobility", name: "Mobility", vehicle_type: "Car", url: "https://www.mobility.ch" },
    ],
  },
};
const IDENTIFY = [
  {
    featureId: "voi:abc",
    geometry: { x: 7.4386, y: 46.9485, spatialReference: { wkid: 4326 } },
    attributes: {
      id: "voi:abc",
      provider_id: "voi",
      provider_name: "Voi",
      vehicle_type: ["E-Scooter"],
      pickup_type: "free_floating",
      available: true,
    },
  },
  {
    featureId: "publibike:101",
    geometry: { x: 7.4395, y: 46.9491 },
    attributes: {
      "ch.bfe.sharedmobility.provider.id": "publibike",
      "ch.bfe.sharedmobility.provider.name": "PubliBike",
      "ch.bfe.sharedmobility.vehicle_type": "E-Bike",
      pickup_type: "station_based",
      station_name: "Bern Bahnhof",
      station_status_num_vehicle_available: 4,
      available: true,
    },
  },
  {
    featureId: "gone",
    geometry: { x: 7.4391, y: 46.95 },
    attributes: { provider_id: "tier", provider_name: "TIER", vehicle_type: "E-Scooter", pickup_type: "free_floating", available: false },
  },
];

const GTFS_SA = {
  header: { gtfsRealtimeVersion: "2.0", timestamp: "1790000000" },
  entity: [
    {
      id: "alert-1",
      alert: {
        activePeriod: [{ start: "1700000000", end: "4000000000" }],
        informedEntity: [{ agencyId: "11", routeId: "91-1-Y-j26-1", stopId: "8500218" }],
        cause: "CONSTRUCTION",
        effect: "REDUCED_SERVICE",
        headerText: { translation: [{ text: "Bauarbeiten Olten", language: "de" }, { text: "Construction work Olten", language: "en" }] },
        descriptionText: { translation: [{ text: "Einschränkungen zwischen Olten und Aarau.", language: "de" }] },
      },
    },
    {
      id: "alert-2",
      alert: {
        active_period: [{ start: 1600000000, end: 1600003600 }],
        informed_entity: [{ agency_id: "33" }],
        header_text: { translation: [{ text: "Old disruption Luzern", language: "en" }] },
      },
    },
  ],
};

const SIRI_SX = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery><SituationExchangeDelivery><Situations>
<PtSituationElement>
  <CreationTime>2026-09-26T06:00:00Z</CreationTime>
  <SituationNumber>ch:1:sstid:100001:abc</SituationNumber>
  <ValidityPeriod><StartTime>2020-01-01T00:00:00Z</StartTime><EndTime>2099-01-01T00:00:00Z</EndTime></ValidityPeriod>
  <AlertCause>constructionWork</AlertCause>
  <Severity>normal</Severity>
  <Summary xml:lang="DE">Streckenunterbruch Lausanne &amp; Genève</Summary>
  <Summary xml:lang="EN">Line interruption Lausanne &amp; Geneva</Summary>
  <Description xml:lang="EN">Replacement buses run.</Description>
  <Affects><Operators><AffectedOperator><OperatorRef>ch:1:sboid:100001</OperatorRef></AffectedOperator></Operators>
  <StopPlaces><AffectedStopPlace><StopPlaceName>Lausanne</StopPlaceName></AffectedStopPlace></StopPlaces></Affects>
</PtSituationElement>
</Situations></SituationExchangeDelivery></ServiceDelivery></Siri>`;

const GTFS_RT = {
  header: { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: "1790000000" },
  entity: [
    {
      id: "t1",
      tripUpdate: {
        trip: { tripId: "1.TA.91-1-Y", routeId: "91-1-Y", startTime: "08:02:00", startDate: "20260926", scheduleRelationship: "SCHEDULED" },
        stopTimeUpdate: [
          { stopSequence: 1, stopId: "8503000:0:31", departure: { delay: 240 } },
          { stopSequence: 2, stopId: "8507000:0:5", arrival: { delay: 300 } },
        ],
      },
    },
    {
      id: "t2",
      trip_update: {
        trip: { trip_id: "2.TA.x", route_id: "x", schedule_relationship: "CANCELED" },
        stop_time_update: [{ stop_id: "ch:1:sloid:3000:4:7", arrival: { delay: 0 } }],
      },
    },
    {
      id: "t3",
      tripUpdate: { trip: { tripId: "3.TA.y" }, stopTimeUpdate: [{ stopId: "8503000", departure: { delay: 20 } }] },
    },
  ],
};

// ---------------------------------------------------------------- pure helpers

test("mobility: classifyVehicle maps GBFS form factors and provider labels", () => {
  assert.equal(classifyVehicle({ form_factor: "bicycle", propulsion_type: "human" }), "bike");
  assert.equal(classifyVehicle({ form_factor: "bicycle", propulsion_type: "electric_assist" }), "e-bike");
  assert.equal(classifyVehicle({ form_factor: "cargo_bicycle" }), "cargo_bike");
  assert.equal(classifyVehicle({ form_factor: "scooter_standing" }), "scooter");
  assert.equal(classifyVehicle({ label: "E-Scooter" }), "scooter");
  assert.equal(classifyVehicle({ label: "E-CargoBike" }), "cargo_bike");
  assert.equal(classifyVehicle({ label: "E-Bike" }), "e-bike");
  assert.equal(classifyVehicle({ label: "Bike" }), "bike");
  assert.equal(classifyVehicle({ label: "E-Moped" }), "moped");
  assert.equal(classifyVehicle({ label: "Car" }), "car");
  assert.equal(classifyVehicle({}), "other");
});

test("mobility: parseIdentifyResults handles plain and prefixed attribute keys", () => {
  const items = parseIdentifyResults(IDENTIFY, BERN);
  assert.equal(items.length, 3);
  assert.equal(items[0].kind, "vehicle");
  assert.equal(items[0].provider, "Voi");
  assert.deepEqual(items[0].vehicle_classes, ["scooter"]);
  assert.ok(items[0].distance_m < 100);
  assert.equal(items[1].kind, "station");
  assert.equal(items[1].provider_id, "publibike");
  assert.equal(items[1].provider, "PubliBike");
  assert.equal(items[1].vehicles_available, 4);
  assert.deepEqual(items[1].vehicle_classes, ["e-bike"]);
  assert.equal(items[2].available, false);
  assert.equal(parseIdentifyResults({ foo: 1 }, BERN), undefined);
  assert.deepEqual(parseIdentifyResults({ results: [] }, BERN), []);
});

test("mobility: normaliseProviders reads apps and multi-type labels", () => {
  const p = normaliseProviders(PROVIDERS);
  assert.equal(p.length, 3);
  assert.equal(p[0].apps.android.startsWith("https://play.google.com"), true);
  assert.deepEqual(p[1].vehicle_classes, ["e-bike", "bike"]);
  assert.equal(normaliseProviders([{ provider_id: "x", name: "X" }])[0].name, "X");
});

test("mobility: distanceM is metres", () => {
  const d = distanceM(46.9488, 7.4391, 46.9578, 7.4391);
  assert.ok(d > 990 && d < 1010, String(d));
});

test("mobility: parseGtfsAlerts + filterDisruptions (camelCase and snake_case)", () => {
  const list = parseGtfsAlerts(GTFS_SA, "en");
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "Construction work Olten");
  assert.equal(list[0].description, "Einschränkungen zwischen Olten und Aarau."); // de fallback
  assert.deepEqual(list[0].operators, ["11"]);
  assert.equal(list[1].active_periods[0].start, new Date(1600000000 * 1000).toISOString());
  const now = new Date("2026-09-26T08:00:00Z");
  assert.equal(filterDisruptions(list, { now }).length, 1); // alert-2 expired
  assert.equal(filterDisruptions(list, { now, activeOnly: false }).length, 2);
  assert.equal(filterDisruptions(list, { now, station: "olten" }).length, 1);
  assert.equal(filterDisruptions(list, { now, station: "8500218" }).length, 1);
  assert.equal(filterDisruptions(list, { now, operator: "11" }).length, 1);
  assert.equal(filterDisruptions(list, { now, text: "zürich" }).length, 0);
  assert.equal(parseGtfsAlerts(GTFS_SA, "de")[0].title, "Bauarbeiten Olten");
});

test("mobility: parseSiriSx extracts situations, language and entities", () => {
  const [s] = parseSiriSx(SIRI_SX, "en");
  assert.equal(s.id, "ch:1:sstid:100001:abc");
  assert.equal(s.title, "Line interruption Lausanne & Geneva");
  assert.equal(s.description, "Replacement buses run.");
  assert.equal(s.cause, "constructionWork");
  assert.deepEqual(s.stops, ["Lausanne"]);
  assert.deepEqual(s.operators, ["ch:1:sboid:100001"]);
  assert.equal(s.active_periods[0].start, "2020-01-01T00:00:00Z");
  assert.equal(parseSiriSx(SIRI_SX, "de")[0].title, "Streckenunterbruch Lausanne & Genève");
  assert.deepEqual(parseSiriSx("<nothing/>"), []);
});

test("mobility: uicFromStopId and extractStopDelays", () => {
  assert.equal(uicFromStopId("8503000:0:31"), "8503000");
  assert.equal(uicFromStopId("8503000"), "8503000");
  assert.equal(uicFromStopId("ch:1:sloid:3000:4:7"), "8503000");
  assert.equal(uicFromStopId("foo"), undefined);
  const rows = extractStopDelays(GTFS_RT, "8503000", 1);
  assert.equal(rows.length, 2); // t1 (4 min) + t2 (cancelled); t3 only 20 s
  assert.equal(rows[0].departure_delay_min, 4);
  assert.equal(rows[1].status, "CANCELED");
  assert.equal(extractStopDelays(GTFS_RT, "8503000", 0).length, 3);
});

// ---------------------------------------------------------------- handlers

test("mobility: get_shared_vehicles_nearby via REST identify, filtered and sorted", async () => {
  await withFetch(
    (url) => (url.startsWith("https://api.sharedmobility.ch/v1/sharedmobility/identify") ? { body: IDENTIFY } : null),
    async (calls) => {
      const res = await toolByName("get_shared_vehicles_nearby").handler({
        lat: 46.9488, lon: 7.4391, radius_m: 500, kind: "all", only_available: true, limit: 25,
      });
      assert.equal(res.isError, undefined);
      const b = body(res);
      assert.equal(b.data.count, 2); // TIER unavailable filtered out
      assert.ok(b.data.results[0].distance_m <= b.data.results[1].distance_m);
      assert.equal(b.source.operator, "Swiss Federal Office of Energy (SFOE)");
      const u = new URL(calls[0].url);
      assert.equal(u.searchParams.get("Geometry"), "7.439100,46.948800");
      assert.equal(u.searchParams.get("Tolerance"), "500");
      assert.equal(u.searchParams.get("geometryFormat"), "esrijson");

      const only = body(
        await toolByName("get_shared_vehicles_nearby").handler({
          lat: 46.9488, lon: 7.4391, radius_m: 500, vehicle_type: "e-bike", kind: "all", only_available: true, limit: 25,
        }),
      );
      assert.equal(only.data.count, 1);
      assert.equal(only.data.results[0].station_name, "Bern Bahnhof");
    },
  );
});

test("mobility: list_shared_mobility_providers reads the REST providers listing and filters", async () => {
  const seen = [];
  await withFetch(
    (url) => {
      seen.push(url);
      return url === "https://api.sharedmobility.ch/v1/sharedmobility/providers" ? { body: PROVIDERS } : null;
    },
    async () => {
      const all = body(await toolByName("list_shared_mobility_providers").handler({ limit: 100 }));
      assert.equal(all.data.count, 3);
      assert.equal(all.source.url, "https://api.sharedmobility.ch/v1/sharedmobility/");
      const cars = body(await toolByName("list_shared_mobility_providers").handler({ vehicle_type: "car", limit: 100 }));
      assert.deepEqual(cars.data.providers.map((p) => p.name), ["Mobility"]);
      const none = await toolByName("list_shared_mobility_providers").handler({ query: "zzz", limit: 100 });
      assert.equal(none.isError, true);
    },
  );
  assert.ok(seen.every((u) => !u.includes("sharedmobility.ch/v2/") && !u.endsWith("gbfs.json")), "GBFS feeds are never fetched");
});
test("mobility: opentransportdata tools explain the missing API key", async () => {
  const saved = process.env.OPENTRANSPORTDATA_API_KEY;
  delete process.env.OPENTRANSPORTDATA_API_KEY;
  try {
    for (const name of ["get_transport_disruptions", "get_realtime_delays"]) {
      const res = await toolByName(name).handler({ station_id: "8503000", min_delay_minutes: 1, active_only: true, lang: "en", limit: 5 });
      assert.equal(res.isError, true);
      const b = body(res);
      assert.match(b.error, /OPENTRANSPORTDATA_API_KEY/);
      assert.ok(b.suggestions.some((s) => s.includes("opentransportdata.swiss")));
    }
  } finally {
    if (saved !== undefined) process.env.OPENTRANSPORTDATA_API_KEY = saved;
  }
});

// Runs before the next test on purpose: the GTFS-SA body is HTTP-cached for
// 60 s, so this fixture also carries the entities the next test filters on.
test("mobility: get_transport_disruptions trims to the 50 KB budget", async () => {
  const saved = process.env.OPENTRANSPORTDATA_API_KEY;
  process.env.OPENTRANSPORTDATA_API_KEY = "test-token";
  const big = Array.from({ length: 100 }, (_, i) => ({
    id: `big-${i}`,
    alert: {
      activePeriod: [{ start: "1700000000", end: "4000000000" }],
      informedEntity: Array.from({ length: 30 }, (_, k) => ({
        agencyId: `op-${k}-${"x".repeat(30)}`,
        routeId: `route-${k}-${"y".repeat(40)}`,
        stopId: `85${String(k).padStart(5, "0")}`,
      })),
      headerText: { translation: [{ text: `Disruption ${i} ${"t".repeat(250)}`, language: "en" }] },
      descriptionText: { translation: [{ text: "d".repeat(2000), language: "en" }] },
    },
  }));
  try {
    await withFetch(
      (url) => (url.startsWith("https://api.opentransportdata.swiss/la/gtfs-sa") ? { body: { ...GTFS_SA, entity: [...GTFS_SA.entity, ...big] } } : null),
      async (calls) => {
        const res = await toolByName("get_transport_disruptions").handler({ text: "Disruption", active_only: true, lang: "en", limit: 100 });
        assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
        assert.equal(res.isError, undefined, res.content[0].text);
        assert.ok(res.content[0].text.length <= 50_000);
        const b = body(res);
        assert.equal(b.data.count, 100);
        assert.ok(b.data.disruptions.length > 0 && b.data.disruptions.length < 100, "trimmed, not withheld");
        assert.match(b.data.truncated, /50 KB/);
        assert.match(b.notes, /omitted/);
      },
    );
  } finally {
    if (saved === undefined) delete process.env.OPENTRANSPORTDATA_API_KEY;
    else process.env.OPENTRANSPORTDATA_API_KEY = saved;
  }
});

test("mobility: fitToBudget shrinks lists (and can drop to zero)", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ i, pad: "p".repeat(500) }));
  const { data, dropped } = fitToBudget(items, (xs) => ({ xs }), 10_000);
  assert.ok(JSON.stringify(data).length <= 10_000);
  assert.ok(dropped > 0 && data.xs.length === 200 - dropped);
  const none = fitToBudget([{ pad: "p".repeat(5000) }], (xs) => ({ xs }), 100);
  assert.equal(none.dropped, 1);
});

test("mobility: get_transport_disruptions with key sends Bearer auth and filters", async () => {
  const saved = process.env.OPENTRANSPORTDATA_API_KEY;
  process.env.OPENTRANSPORTDATA_API_KEY = "test-token";
  try {
    await withFetch(
      (url) => (url.startsWith("https://api.opentransportdata.swiss/la/gtfs-sa") ? { body: GTFS_SA } : null),
      async (calls) => {
        const res = await toolByName("get_transport_disruptions").handler({ station: "Olten", active_only: true, lang: "en", limit: 20 });
        assert.equal(res.isError, undefined, res.content[0].text);
        const b = body(res);
        assert.equal(b.data.count, 1);
        assert.equal(b.data.disruptions[0].title, "Construction work Olten");
        // The feed may be served from the 60 s HTTP cache filled by the previous test.
        if (calls.length) assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
      },
    );
  } finally {
    if (saved === undefined) delete process.env.OPENTRANSPORTDATA_API_KEY;
    else process.env.OPENTRANSPORTDATA_API_KEY = saved;
  }
});

test("mobility: get_realtime_delays with key returns station delays", async () => {
  const saved = process.env.OPENTRANSPORTDATA_API_KEY;
  process.env.OPENTRANSPORTDATA_API_KEY = "test-token";
  try {
    await withFetch(
      (url) => (url.startsWith("https://api.opentransportdata.swiss/la/gtfs-rt") ? { body: GTFS_RT } : null),
      async () => {
        const res = await toolByName("get_realtime_delays").handler({ station_id: "8507000", min_delay_minutes: 1, limit: 10 });
        assert.equal(res.isError, undefined, res.content[0].text);
        const b = body(res);
        assert.equal(b.data.count, 1);
        assert.equal(b.data.delays[0].arrival_delay_min, 5);
        assert.equal(b.data_as_of, new Date(1790000000 * 1000).toISOString());
      },
    );
  } finally {
    if (saved === undefined) delete process.env.OPENTRANSPORTDATA_API_KEY;
    else process.env.OPENTRANSPORTDATA_API_KEY = saved;
  }
});

test("mobility: indexStopDelays keeps compact per-station rows and drops on-time rows first under the cap", () => {
  const idx = indexStopDelays(GTFS_RT);
  assert.equal(idx.feed_timestamp, new Date(1790000000 * 1000).toISOString());
  assert.deepEqual([...idx.byStation.keys()].sort(), ["8503000", "8507000"]);
  assert.equal(stopDelaysFromIndex(idx, "8503000", 1).length, 2);
  assert.equal(idx.truncated, false);
  const feed = {
    entity: [
      {
        tripUpdate: {
          trip: { tripId: "a" },
          stopTimeUpdate: [
            { stopId: "8503000", arrival: { delay: 0 } },
            { stopId: "8507000", arrival: { delay: 120 } },
            { stopId: "8507000", arrival: { delay: 0 }, scheduleRelationship: "SKIPPED" },
          ],
        },
      },
    ],
  };
  const capped = indexStopDelays(feed, { maxRows: 10, maxOnTimeRows: 0 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.rows, 2); // on-time row dropped; delayed and SKIPPED kept
  assert.equal(stopDelaysFromIndex(capped, "8507000", 1)[0].arrival_delay_min, 2);
  assert.equal(stopDelaysFromIndex(capped, "8507000", 1)[1].status, "SKIPPED");
});

test("mobility: get_realtime_delays caches the parsed feed and single-flights concurrent downloads", async () => {
  const saved = process.env.OPENTRANSPORTDATA_API_KEY;
  process.env.OPENTRANSPORTDATA_API_KEY = "test-token";
  clearRealtimeIndexCache();
  const orig = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("https://api.opentransportdata.swiss/la/gtfs-rt")) return new Response("nf", { status: 404 });
    downloads++;
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify(GTFS_RT), { status: 200 });
  };
  try {
    const t = toolByName("get_realtime_delays");
    const [a, b] = await Promise.all([
      t.handler({ station_id: "8507000", min_delay_minutes: 1, limit: 10 }),
      t.handler({ station_id: "8503000", min_delay_minutes: 1, limit: 10 }),
    ]);
    assert.equal(downloads, 1, "concurrent calls share one download");
    assert.equal(body(a).data.count, 1);
    assert.equal(body(b).data.count, 2);
    // The raw HTTP cache is bypassed (TTL 0); the parsed index serves repeat calls.
    const c = await t.handler({ station_id: "8503000", min_delay_minutes: 0, limit: 10 });
    assert.equal(downloads, 1, "later call is served from the parsed-feed cache");
    const cb = body(c);
    assert.equal(cb.data.count, 3);
    assert.equal(cb.cache_status, "hit");
    assert.equal(cb.data_as_of, new Date(1790000000 * 1000).toISOString());
  } finally {
    globalThis.fetch = orig;
    clearRealtimeIndexCache();
    if (saved === undefined) delete process.env.OPENTRANSPORTDATA_API_KEY;
    else process.env.OPENTRANSPORTDATA_API_KEY = saved;
  }
});

test("mobility: module shape: unique tool names, probes, sources", () => {
  assert.equal(mobilityModule.id, "mobility");
  const names = mobilityModule.tools.map((t) => t.name);
  assert.deepEqual(names, ["get_shared_vehicles_nearby", "list_shared_mobility_providers", "get_transport_disruptions", "get_realtime_delays"]);
  const ids = new Set(mobilityModule.sources.map((s) => s.id));
  for (const p of mobilityModule.healthProbes) assert.ok(ids.has(p.sourceId));
});

