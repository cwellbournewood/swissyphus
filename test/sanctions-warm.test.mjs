/**
 * Offline tests for the SECO sanctions cold-start path: the on-disk snapshot of
 * the parsed index (restart = no 40 MB download), the background warm-up used
 * in HTTP mode, and the 3-day cap on serving an old list.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetForTests } from "../dist/core/http.js";
import { configureLkg, getLkgStats, lkgFlush } from "../dist/core/lkg.js";
import { getIndex, sanctionsModule, setSanctionsIndexForTests, warmSanctionsIndex } from "../dist/modules/sanctions.js";

const realFetch = globalThis.fetch;
const DAY = 86_400_000;

/** A well-formed list with `n` targets (the loader rejects lists under 1000 as incomplete). */
function bigList(n = 1200) {
  const targets = Array.from(
    { length: n },
    (_, i) =>
      `<target ssid="${10_000 + i}"><sanctions-set-id>5000</sanctions-set-id><individual><identity ssid="${50_000 + i}" main="true">` +
      `<name ssid="${90_000 + i}" name-type="primary-name" lang="eng"><name-part order="1" name-part-type="whole-name"><value>Person Number${i}</value></name-part></name>` +
      `</identity></individual><modification modification-type="listed" effective-date="2024-01-01"/></target>`,
  ).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><swiss-sanctions-list list-type="whole-list" date="2026-11-04">` +
    `<sanctions-program ssid="99" version-date="2026-11-03"><program-key lang="eng">Situation in Ukraine</program-key>` +
    `<program-name lang="eng">Ordinance of 4 March 2022</program-name><sanctions-set ssid="5000" lang="eng">annexe 8</sanctions-set><origin>EU</origin></sanctions-program>` +
    `${targets}</swiss-sanctions-list>`
  );
}

let calls = 0;
function serve(handler) {
  calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    return handler(String(url), init);
  };
}

let dir;
beforeEach(() => {
  __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 });
  dir = mkdtempSync(join(tmpdir(), "swissyphus-sanctions-"));
  configureLkg(undefined);
  setSanctionsIndexForTests(undefined);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSanctionsIndexForTests(undefined);
  configureLkg(undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("sanctions: module exposes a warm-up hook (run in HTTP mode only)", () => {
  assert.equal(typeof sanctionsModule.warmUp, "function");
  assert.equal(sanctionsModule.sources[0].maxStaleSeconds, 3 * 86_400);
});

test("sanctions: warm-up loads the list and snapshots the parsed index; a restart restores it without downloading", async () => {
  configureLkg(dir);
  const xml = bigList();
  serve(() => new Response(xml, { headers: { "content-type": "text/xml" } }));
  await warmSanctionsIndex();
  assert.equal(calls, 1);
  await lkgFlush();
  assert.equal(getLkgStats().entries, 1, "snapshot written");

  // Restart: memory empty, upstream down. The snapshot answers immediately.
  __resetForTests({ retryDelayMs: 1, breakerCooldownMs: 60 });
  configureLkg(dir);
  setSanctionsIndexForTests(undefined);
  serve(() => new Response("down", { status: 503 }));
  const r = await getIndex(2_000);
  assert.equal(calls, 0, "no download needed");
  assert.equal(r.index.targets.length, 1200);
  assert.equal(r.cacheStatus, "hit");
  assert.equal(r.index.byId.get("10007").primary_name, "Person Number7");
  assert.equal(r.index.programs[0].key, "Situation in Ukraine");
});

test("sanctions: a stale index is served (and refreshed) within 3 days, refused after", async () => {
  configureLkg(undefined);
  const xml = bigList();
  serve(() => new Response(xml));
  await warmSanctionsIndex();
  const loaded = (await getIndex()).index;

  // 1 day old: served as stale while a background refresh runs.
  serve(() => new Response("down", { status: 503 }));
  setSanctionsIndexForTests(loaded, Date.now() - 1 * DAY);
  const stale = await getIndex(2_000);
  assert.equal(stale.cacheStatus, "stale");

  // 4 days old and the source is down: an error, never a 4-day-old screen.
  setSanctionsIndexForTests(loaded, Date.now() - 4 * DAY);
  await assert.rejects(() => getIndex(2_000));
});
