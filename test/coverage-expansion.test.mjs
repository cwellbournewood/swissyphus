/**
 * Offline tests for the coverage-expansion connectors: SECO sanctions,
 * simap.ch procurement, FOPH disease surveillance, the SFOE energy dashboard,
 * OpenParlData, I14Y, swisscovery, GLAMOS, the ÖREB cadastre and Fedlex
 * consultations. Fixtures are trimmed copies of live responses (Nov 2026).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSanctionsXml,
  searchIndex,
  matchScore,
  normName,
  publicTarget,
  setSanctionsIndexForTests,
  sanctionsModule,
} from "../dist/modules/sanctions.js";
import { mapSearchProject, summarizePublication, flattenCpv, htmlText, procurementModule } from "../dist/modules/procurement.js";
import { filterIdd, splitCsvLine, TOPICS } from "../dist/modules/health.js";
import { normalizeSeries, aggregateSeries, SERIES } from "../dist/modules/energyDashboard.js";
import { parseCsv } from "../dist/core/tabular.js";
import { flat, mapAffair, mapPerson, mapBody } from "../dist/modules/localpolitics.js";
import { mapCodeEntry, mapSearchHit } from "../dist/modules/i14y.js";
import { buildCql, parseSru } from "../dist/modules/libraries.js";
import { parseGlamosCsv, findGlacier } from "../dist/modules/glaciers.js";
import { summarizeExtract, parcelFromAttrs, txt } from "../dist/modules/cadastre.js";
import { buildConsultationQuery } from "../dist/modules/law.js";
import { ALL_MODULES, PRESETS } from "../dist/registry.js";

const body = (r) => JSON.parse(r.content[0].text);

// ── SECO sanctions ───────────────────────────────────────────────────────

const SECO_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><swiss-sanctions-list list-type="whole-list" date="2026-11-04">
<sanctions-program ssid="20" version-date="2026-11-03"><program-key lang="eng">Belarus</program-key><program-key lang="ger">Belarus</program-key><program-name lang="eng">Ordinance of 16 March 2022 on measures against Belarus (SR 946.231.116.9)</program-name><sanctions-set ssid="4387" lang="eng">article 12 (Financial sanctions), annexe 13</sanctions-set><sanctions-set ssid="4387" lang="ger">Art. 12</sanctions-set><origin>EU</origin></sanctions-program>
<sanctions-program ssid="99" version-date="2026-11-03"><program-key lang="eng">Situation in Ukraine</program-key><program-name lang="eng">Ordinance of 4 March 2022 (SR 946.231.176.72)</program-name><sanctions-set ssid="5000" lang="eng">art. 15, annexe 8</sanctions-set><origin>EU</origin></sanctions-program>
<target ssid="5142"><sanctions-set-id>4387</sanctions-set-id><individual><identity ssid="5144" main="true"><name ssid="1" name-type="primary-name" quality="good" lang="eng"><name-part order="1" name-part-type="family-name"><value>Lukashenka</value><spelling-variant lang="RUS" script="LATN" spelling-variant-type="not-defined">Lukashenko</spelling-variant><spelling-variant lang="RUS" script="CYRL" spelling-variant-type="not-defined">ЛУКАШЕНКО</spelling-variant></name-part><name-part order="2" name-part-type="given-name"><value>Dzmitry</value><spelling-variant lang="RUS" script="LATN" spelling-variant-type="not-defined">Dmitri</spelling-variant></name-part></name><day-month-year ssid="2" day="23" month="3" year="1980" calendar="Gregorian" quality="good"/><nationality ssid="3"><country iso-code="BY">Belarus</country></nationality><address ssid="4" place-id="21" quality="good"><c-o>President&apos;s Sports Club</c-o><zip-code>220029</zip-code></address></identity><justification ssid="5">Businessman &amp; chairman.</justification></individual><modification modification-type="de-listed" enactment-date="2016-02-29" effective-date="2016-03-01"/><modification modification-type="listed"><added><target ssid="5142"><sanctions-set-id>4387</sanctions-set-id><individual><identity ssid="9" main="true"><name ssid="10" name-type="primary-name" lang="eng"><name-part order="1" name-part-type="whole-name"><value>Shadow Copy Must Be Ignored</value></name-part></name></identity></individual></target></added></modification></target>
<target ssid="28544"><sanctions-set-id>5000</sanctions-set-id><individual><identity ssid="28546" main="true"><name ssid="28547" name-type="primary-name" lang="eng"><name-part order="1" name-part-type="family-name"><value>Rotenberg</value></name-part><name-part order="2" name-part-type="given-name"><value>Arkady</value></name-part><name-part order="3" name-part-type="father-name"><value>Romanovich</value></name-part></name><name ssid="28548" name-type="alias" lang="eng"><name-part order="1" name-part-type="whole-name"><value>Arkadii Rotenberg</value></name-part></name><day-month-year ssid="28549" day="15" month="12" year="1951"/><place-of-birth ssid="28550" place-id="300" quality="good"/></identity><justification ssid="28551">Leading businessperson.</justification><relation ssid="7" target-id="28600" relation-type="related-to"></relation></individual><modification modification-type="amended" effective-date="2023-12-21"/><modification modification-type="listed" effective-date="2014-08-27" publication-date="2014-08-27"/></target>
<target ssid="28600"><sanctions-set-id>5000</sanctions-set-id><entity><identity ssid="28601" main="true"><name ssid="28602" name-type="primary-name" lang="eng"><name-part order="1" name-part-type="whole-name"><value>JSC Stroygazmontazh</value></name-part></name></identity></entity><modification modification-type="listed" effective-date="2014-09-12"/></target>
<target ssid="34461"><sanctions-set-id>5000</sanctions-set-id><object object-type="vessel"><identity ssid="34462" main="true"><name ssid="34463" name-type="primary-name" lang="eng"><name-part order="1" name-part-type="whole-name"><value>Hui Chon</value></name-part></name></identity><other-information ssid="34465">IMO Number: 8405270</other-information></object><modification modification-type="listed" effective-date="2016-05-18"/></target>
<place ssid="21"><country iso-code="BY">Belarus</country></place><place ssid="300"><location>St Petersburg</location><country iso-code="RU">Russian Federation</country></place>
</swiss-sanctions-list>`;

test("sanctions: parses programmes, targets, places and status; skips history copies", () => {
  const idx = parseSanctionsXml(SECO_XML);
  assert.equal(idx.listDate, "2026-11-04");
  assert.equal(idx.targets.length, 4);
  assert.equal(idx.programs.length, 2);
  const luk = idx.byId.get("5142");
  assert.equal(luk.primary_name, "Lukashenka Dzmitry");
  assert.equal(luk.status, "de-listed", "newest modification is de-listed");
  assert.deepEqual(luk.birth_dates, ["1980-03-23"]);
  assert.deepEqual(luk.nationalities, ["Belarus (BY)"]);
  assert.match(luk.addresses[0], /c\/o President's Sports Club, 220029, Belarus/);
  assert.equal(luk.justification, "Businessman & chairman.");
  assert.ok(luk.spelling_variants.includes("Lukashenko Dmitri"), JSON.stringify(luk.spelling_variants));
  assert.ok(!JSON.stringify(idx.targets).includes("Shadow Copy"), "history inside <modification> is ignored");
  const rot = idx.byId.get("28544");
  assert.equal(rot.program, "Situation in Ukraine");
  assert.equal(rot.listed_on, "2014-08-27");
  assert.deepEqual(rot.places_of_birth, ["St Petersburg, Russian Federation"]);
  assert.deepEqual(rot.aliases, ["Arkadii Rotenberg"]);
  assert.equal(idx.byId.get("34461").object_type, "vessel");
});

test("sanctions: diacritic-insensitive matching, de-listed hidden by default, type filter", () => {
  const idx = parseSanctionsXml(SECO_XML);
  assert.equal(normName("Rötenberg, Arkády!"), "rotenberg arkady");
  assert.equal(matchScore(idx.byId.get("28544"), "rotenberg arkady romanovich"), 100);
  assert.equal(matchScore(idx.byId.get("28544"), "arkady rotenberg"), 80);
  assert.equal(matchScore(idx.byId.get("28544"), "roten"), 60);
  assert.equal(searchIndex(idx, { name: "Lukashenko", limit: 5 }).total, 0);
  assert.equal(searchIndex(idx, { name: "Lukashenko", includeDelisted: true, limit: 5 }).hits[0].target.id, "5142");
  assert.equal(searchIndex(idx, { name: "Stroygazmontazh", type: "individual", limit: 5 }).total, 0);
  assert.equal(searchIndex(idx, { name: "Hui Chon", program: "ukraine", limit: 5 }).total, 1);
  assert.equal(publicTarget(idx.byId.get("28544"))._match, undefined);
});

test("sanctions: tool handlers answer from the loaded index", async () => {
  setSanctionsIndexForTests(parseSanctionsXml(SECO_XML));
  try {
    const t = (n) => sanctionsModule.tools.find((x) => x.name === n);
    const s = body(await t("search_sanctions_list").handler({ name: "rotenberg", include_delisted: false, limit: 10 }));
    assert.equal(s.data.total_matches, 1);
    assert.equal(s.data.results[0].name, "Rotenberg Arkady Romanovich");
    const e = body(await t("get_sanctions_entry").handler({ id: "28544" }));
    assert.equal(e.data.related_targets[0].name, "JSC Stroygazmontazh");
    const p = body(await t("list_sanctions_programs").handler({}));
    assert.deepEqual(p.data.programs.find((x) => x.program === "Situation in Ukraine").listed, { individual: 1, entity: 1, object: 1 });
    const none = body(await t("search_sanctions_list").handler({ name: "Nobody Atall", include_delisted: false, limit: 10 }));
    assert.equal(none.data.total_matches, 0);
  } finally {
    setSanctionsIndexForTests(undefined);
  }
});

// ── simap.ch procurement ─────────────────────────────────────────────────

const AWARD = {
  id: "cf69fc8b-9829-4bd7-99b8-069403cb5227",
  type: "award",
  "project-info": {
    title: { de: "Neubau Burgfelderstrasse 251, BKP 271 Gipserarbeiten", fr: null },
    procOfficeAddress: { name: { de: "Kantonale Fachstelle für öffentliche Beschaffungen" }, street: { de: "Münsterplatz 11" }, postalCode: "4001", city: { de: "Basel" }, email: "kfoeb@bs.ch" },
  },
  procurement: {
    orderDescription: { de: "<p>Gipserarbeiten&nbsp;für den <b>Neubau</b></p><ul><li>Los 1</li></ul>" },
    processType: "open",
    orderType: "construction",
    orderAddress: { postalCode: "4055", city: { de: "Basel" }, cantonId: "BS" },
    cpvCode: { code: "45410000", label: { de: "Verputzarbeiten", en: "Plastering work" } },
    additionalCpvCodes: [],
  },
  dates: { publicationDate: "2026-11-07" },
  base: { projectId: "4d0e51ce-4938-4b55-9ec2-445cceab01aa", projectNumber: "39037", publicationNumber: "39037-02" },
  decision: {
    vendors: [{ vendorName: "Egli AG Basel, Allschwil", vendorAddress: { postalCode: "4123", city: "Allschwil", cantonId: "BL" }, price: { currency: "chf", price: 452220.84, vatType: "full" }, rank: null }],
    numberOfSubmissions: 7,
    awardDecisionDate: "2026-11-06",
    awardDecisionJustification: { de: "Meiste Nutzwertpunkte." },
  },
  referencingPub: { publicationId: "6e183745-06f6-4de9-87cb-e16998e8a46c", pubType: "tender", publicationDate: "2026-06-16" },
  terms: { remediesNotice: { de: "Gegen diese Verfügung kann innert 20 Tagen Beschwerde erhoben werden." } },
};

test("procurement: search rows, award summary, CPV tree and HTML stripping", () => {
  const row = mapSearchProject(
    {
      id: "p1",
      title: { de: "Schulhaus", fr: "École" },
      publicationId: "u1",
      pubType: "tender",
      projectSubType: "construction",
      procOfficeName: { de: "Stadt Zug" },
      orderAddress: { cantonId: "ZG", postalCode: "6300", city: { de: "Zug" } },
    },
    "fr",
  );
  assert.equal(row.title, "École");
  assert.equal(row.contracting_authority, "Stadt Zug", "falls back to German");
  assert.equal(row.location, "6300 Zug ZG");
  const s = summarizePublication(AWARD, "de");
  assert.equal(s.award.number_of_offers, 7);
  assert.deepEqual(s.award.awarded_to[0], { name: "Egli AG Basel, Allschwil", location: "4123 Allschwil BL", price: { amount: 452220.84, currency: "CHF", vat: "full" } });
  assert.equal(s.description, "Gipserarbeiten für den Neubau\n• Los 1");
  assert.equal(s.cpv.code, "45410000");
  assert.equal(s.previous_notice.type, "tender");
  assert.equal(s.place_of_performance, "4055 Basel BS");
  const cpv = flattenCpv([{ code: "45000000", label: { de: "Bauarbeiten" }, codes: [{ code: "45200000", label: { de: "Tiefbau" } }] }], "de");
  assert.deepEqual(cpv.map((c) => [c.code, c.depth]), [["45000000", 0], ["45200000", 1]]);
  assert.equal(htmlText("a".repeat(30), 10), "aaaaaaaaaa…");
});

test("procurement: search sends repeated array params and requires a query or filter", async () => {
  const t = procurementModule.tools.find((x) => x.name === "search_public_tenders");
  const empty = await t.handler({ lang: "de" });
  assert.equal(empty.isError, true);
  const orig = globalThis.fetch;
  let seen;
  globalThis.fetch = async (u) => {
    seen = new URL(String(u));
    return new Response(JSON.stringify({ projects: [{ id: "a", publicationId: "b", title: { de: "X" } }], pagination: { lastItem: "20261028|1", itemsPerPage: 1 } }));
  };
  try {
    const r = body(await t.handler({ cantons: ["ZH", "BE"], notice_types: ["tender"], lang: "de" }));
    assert.deepEqual(seen.searchParams.getAll("orderAddressCantons"), ["ZH", "BE"]);
    assert.deepEqual(seen.searchParams.getAll("newestPubTypes"), ["tender"]);
    assert.equal(r.data.next_cursor, "20261028|1");
  } finally {
    globalThis.fetch = orig;
  }
});

// ── FOPH disease surveillance ────────────────────────────────────────────

const IDD = [
  "valueCategory,temporal,temporal_type,georegion,georegion_type,agegroup,agegroup_type,sex,type,value,pop,incValue,trend,dataComplete",
  "cases,2026-W42,iso_week,ZH,canton,all,x,all,all,12,1632918,0.73,NA,TRUE",
  "cases,2026-W43,iso_week,ZH,canton,all,x,all,all,16,1632918,0.98,NA,TRUE",
  "cases,2026-W44,iso_week,ZH,canton,all,x,all,all,21,1632918,1.29,rising,FALSE",
  "cases,2026-W44,iso_week,ZH,canton,0 - 4,x,all,all,3,1,1,NA,FALSE",
  "cases,2026-W44,iso_week,ZH,canton,all,x,female,all,11,1,1,NA,FALSE",
  "cases,2026-W44,iso_week,CHFL,CHFL,all,x,all,all,140,9000000,1.5,NA,FALSE",
  "max_value_10y,2026-W44,iso_week,CHFL,CHFL,all,x,all,all,400,NA,NA,NA,TRUE",
].join("\n");

test("health: IDD filter pins dimensions to 'all', keeps the last periods and supports breakdowns", () => {
  const r = filterIdd(IDD, { region: "zh", lastPeriods: 2 });
  assert.equal(r.value_category, "cases");
  assert.deepEqual(r.rows.map((x) => [x.period, x.value]), [["2026-W43", 16], ["2026-W44", 21]]);
  assert.equal(r.rows[1].provisional, true);
  assert.equal(r.rows[1].trend, "rising");
  const b = filterIdd(IDD, { region: "ZH", lastPeriods: 1, breakdown: "agegroup" });
  assert.deepEqual(b.breakdown_values, ["0 - 4", "all"]);
  assert.deepEqual(filterIdd(IDD, { region: "CHFL", lastPeriods: 5 }).value_categories, ["cases", "max_value_10y"]);
  assert.equal(filterIdd(IDD, { region: "CHFL", lastPeriods: 5, valueCategory: "max_value_10y" }).rows[0].value, 400);
  assert.equal(filterIdd(IDD, { region: "ZH", lastPeriods: 9, from: "2026-W44" }).rows.length, 1);
  assert.equal(filterIdd(IDD, { region: "GE", lastPeriods: 5 }).rows.length, 0);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
  assert.ok(TOPICS.length >= 20 && TOPICS.every((t) => /^[A-Za-z0-9_]+$/.test(t.export)));
});

test("health: wastewater rows use georegion1/2 and rows without any measurement are dropped", () => {
  const csv = [
    "valueCategory,temporal,temporal_type,georegion1,georegion1_type,georegion2,georegion2_type,conc,pop,value,valueMean7d,trend,dataComplete",
    "influenza_a,2026-10-25,date,BS,canton,basel,wwtp,1516.7,273075,44744034080,NA,stagnant,FALSE",
    "influenza_a,2026-10-26,date,BS,canton,basel,wwtp,NA,273075,NA,NA,NA,FALSE",
  ].join("\n");
  const r = filterIdd(csv, { region: "basel", lastPeriods: 5 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].site, "basel");
  assert.equal(r.rows[0].region, "BS");
  assert.equal(r.rows[0].conc, 1516.7);
});

// ── Energy dashboard ─────────────────────────────────────────────────────

test("energy dashboard: normalise dates, monthly Jahr/Monat, sum and mean aggregation, ISO weeks", () => {
  const prod = normalizeSeries(parseCsv("﻿Datum,Energietraeger,Produktion_GWh\n2026-01-01,Kernkraft,60\n2026-01-02,Kernkraft,61.5\n2026-02-01,Kernkraft,59\n2026-01-01,Wind,0.4\n", { delimiter: "," }));
  const monthly = aggregateSeries(prod.rows, "month", "sum", "Energietraeger");
  assert.deepEqual(monthly.find((r) => r.period === "2026-01" && r.Energietraeger === "Kernkraft"), { period: "2026-01", Energietraeger: "Kernkraft", days: 2, Produktion_GWh: 121.5 });
  const price = normalizeSeries(parseCsv("Datum,Baseload_EUR_MWh\n2026-11-02,281\n2026-11-03,291\n", { delimiter: "," }));
  assert.equal(aggregateSeries(price.rows, "week", "mean")[0].Baseload_EUR_MWh, 286);
  assert.equal(aggregateSeries(price.rows, "week", "mean")[0].period, "2026-W45");
  const gas = normalizeSeries(parseCsv("Jahr,Monat,Importierte_Energie_GWh\n2026,9,1015.563\n", { delimiter: "," }));
  assert.equal(gas.rows[0].date, "2026-09");
  assert.ok(SERIES.every((s) => s.file.endsWith(".csv")));
});

// ── OpenParlData, I14Y, swisscovery ──────────────────────────────────────

test("localpolitics: flat language fields with fallback; affair/person/body mapping", () => {
  const a = { id: 342653, body_key: "BL", number: "2026/7405", title_de: "Sichere Veloquerung", type_harmonized_en: "Postulate", type_harmonized_de: "Postulat", state_name_de: "In Bearbeitung", begin_date: "2026-11-05T00:00:00", url_external_de: "https://baselland.talus.ch/x" };
  assert.deepEqual(mapAffair(a, "en"), { id: 342653, body_key: "BL", number: "2026/7405", title: "Sichere Veloquerung", type: "Postulate", state: "In Bearbeitung", submitted: "2026-11-05", closed: undefined, url: "https://baselland.talus.ch/x" });
  assert.equal(flat({ name: { de: "Zürich", fr: "Zurich" } }, "name", "fr"), "Zurich");
  assert.equal(mapPerson({ id: 1, fullname: "Irène Meier", party_harmonized_de: "Die Grünen" }, "de").party, "Die Grünen");
  assert.equal(mapBody({ body_key: "230", name_de: "Winterthur", legislative_name_de: "Stadtparlament", type: "city" }, "de").parliament, "Stadtparlament");
});

test("i14y: code-list entries and search hits", () => {
  const e = mapCodeEntry({ code: "6411", name: { de: "Zentralbanken", en: "Central banking" }, annotations: [{ type: "ABBREV", text: { en: "Central banking" } }, { type: "DESCR", text: { en: "This class includes…" } }] }, "en");
  assert.deepEqual(e, { code: "6411", name: "Central banking", short_name: "Central banking", description: "This class includes…" });
  const h = mapSearchHit({ id: "x", identifier: "NOGA_CLASS", type: "Concept", conceptType: "CodeList", title: { en: "NOGA Class" }, publisher: { name: { en: "FSO" } }, registrationStatus: "PreferredStandard" }, "en");
  assert.equal(h.concept_type, "CodeList");
  assert.equal(h.publisher, "FSO");
});

test("libraries: CQL building strips injection characters; MARC21 records are mapped", () => {
  assert.equal(buildCql({ title: 'Heidi" OR alma.title=("x', author: "Spyri" }), 'alma.title="Heidi OR alma.title x" AND alma.creator="Spyri"');
  assert.equal(buildCql({ isbn: "978-3-03-695152-2" }), "alma.isbn=9783036951522");
  assert.equal(buildCql({}), undefined);
  const xml = `<searchRetrieveResponse><numberOfRecords>2483</numberOfRecords><records><record><recordData><record xmlns="http://www.loc.gov/MARC21/slim">
<controlfield tag="001">991171847997405501</controlfield><controlfield tag="008">190101s2019    ch            000 1 ger d</controlfield>
<datafield ind1="0" ind2="0" tag="245"><subfield code="a">Heidi :</subfield><subfield code="b">Lehr- und Wanderjahre /</subfield></datafield>
<datafield ind1="1" ind2=" " tag="100"><subfield code="a">Spyri, Johanna,</subfield></datafield>
<datafield ind1=" " ind2="1" tag="264"><subfield code="a">Zürich :</subfield><subfield code="b">Diogenes,</subfield><subfield code="c">2019</subfield></datafield>
<datafield tag="020" ind1=" " ind2=" "><subfield code="a">9783257000000 (Broschur)</subfield></datafield>
<datafield tag="650" ind1=" " ind2="7"><subfield code="a">Kinderliteratur</subfield></datafield>
</record></recordData></record></records></searchRetrieveResponse>`;
  const r = parseSru(xml);
  assert.equal(r.total, 2483);
  assert.deepEqual(
    { ...r.records[0], url: undefined },
    { id: "991171847997405501", title: "Heidi: Lehr- und Wanderjahre", creators: ["Spyri, Johanna"], publisher: "Diogenes", place: "Zürich", year: "2019", language: "ger", isbn: ["9783257000000"], subjects: ["Kinderliteratur"], url: undefined },
  );
});

// ── GLAMOS, ÖREB, Fedlex consultations ───────────────────────────────────

test("glaciers: GLAMOS CSV preamble, header and unit lines are handled", () => {
  const csv = `The data of the Swiss Glacier Monitoring Network (GLAMOS) are freely available.
When using these data, please cite as:
GLAMOS (2025). Swiss Glacier Length Change, release 2025, doi:10.18750/lengthchange.2025.r2025.

SWISS GLACIER LENGTH CHANGE

glacier name,glacier id,start date of observation,quality of start date,end date of observation,quality of end date,length change,elevation of glacier tongue,observer
,(according to Swiss Glacier Inventory),date_start,x = date not exactly known,date_end,x = date not exactly known,dL,h_min,
,,yyyy-mm-dd (ISO 8601),,yyyy-mm-dd (ISO 8601),,m,m asl.,
Rhonegletscher,B43-03,2022-07-16,,2023-08-20,,-95.50,,VAW
Rhonegletscher,B43-03,2023-08-20,,2024-08-23,,-115.10,,VAW
Oberaletschgletscher,B36-01,2023-08-20,,2024-08-23,,-20.00,,VAW
`;
  const p = parseGlamosCsv(csv);
  assert.equal(p.header[0], "glacier name");
  assert.equal(p.rows.length, 3);
  assert.match(p.citation, /^GLAMOS \(2025\)/);
  assert.deepEqual(findGlacier(p, "rhone"), [{ name: "Rhonegletscher", id: "B43-03" }, { name: "Rhonegletscher", id: "B43-03" }]);
  assert.deepEqual(findGlacier(p, "B36-01"), [{ name: "Oberaletschgletscher", id: "B36-01" }]);
});

test("cadastre: parcel reference from geo.admin attributes and ÖREB extract summary", () => {
  const ref = parcelFromAttrs({ egris_egrid: "CH399977799134", number: "AA735", gemeindename: "Zürich", oereb_status_de: "ÖREB-Kataster eingeführt", oereb_webservice: "https://maps.zh.ch/oereb/v2", oereb_extract_pdf: "https://maps.zh.ch/oereb/v2/extract/pdf/?EGRID=CH399977799134" }, "de");
  assert.equal(ref.service, "https://maps.zh.ch/oereb/v2");
  assert.equal(parcelFromAttrs({}, "de"), undefined);
  assert.equal(txt([{ Language: "fr", Text: "Zone" }, { Language: "de", Text: "Zone DE" }], "it"), "Zone DE");
  const doc = {
    GetExtractByIdResponse: {
      Extract: {
        CreationDate: "2026-11-07T17:18:52",
        ConcernedTheme: [{ code: "ch.Nutzungsplanung", Text: [{ Language: "de", Text: "Nutzungsplanung" }] }],
        NotConcernedTheme: [{ code: "ch.Planungszonen", Text: [{ Language: "de", Text: "Planungszonen" }] }],
        ThemeWithoutData: [],
        RealEstate: {
          EGRID: "CH399977799134", Number: "AA735", Canton: "ZH", MunicipalityName: "Zürich", MunicipalityCode: 261, LandRegistryArea: 262,
          RestrictionOnLandownership: [
            {
              LegendText: [{ Language: "de", Text: "Kernzone" }],
              Theme: { code: "ch.Nutzungsplanung", SubCode: "ch.ZH.Grundnutzung", Text: [{ Language: "de", Text: "Nutzungsplanung: Grundnutzungen" }] },
              Lawstatus: { Code: "inForce", Text: [{ Language: "de", Text: "Rechtskräftig" }] },
              AreaShare: 262,
              PartInPercent: 100,
              ResponsibleOffice: { Name: [{ Language: "de", Text: "Stadt Zürich" }] },
              LegalProvisions: [
                { Type: { Code: "LegalProvision" }, Title: [{ Language: "de", Text: "Bauordnung 2016" }], TextAtWeb: [{ Language: "de", Text: "https://oerebdocs.zh.ch/getDoc?docid=6" }] },
                { Type: { Code: "Law" }, Title: [{ Language: "de", Text: "Raumplanungsgesetz (RPG)" }] },
              ],
            },
          ],
        },
        PLRCadastreAuthority: { Name: [{ Language: "de", Text: "Amt für Raumentwicklung" }] },
      },
    },
  };
  const s = summarizeExtract(doc, "de");
  assert.equal(s.parcel.area_m2, 262);
  assert.deepEqual(s.concerned_themes, ["Nutzungsplanung"]);
  assert.deepEqual(s.not_concerned_themes, ["Planungszonen"]);
  assert.equal(s.restrictions[0].restriction, "Kernzone");
  assert.equal(s.restrictions[0].percent_of_parcel, 100);
  assert.deepEqual(s.restrictions[0].legal_basis, ["Raumplanungsgesetz (RPG)"]);
  assert.equal(s.restrictions[0].legal_provisions[0].url, "https://oerebdocs.zh.ch/getDoc?docid=6");
});

test("law: consultation SPARQL sanitises user text and maps status filters", () => {
  const q = buildConsultationQuery({ query: 'Energie") } DROP', status: "ongoing", language: "fr", limit: 999 });
  assert.match(q, /CONTAINS\(LCASE\(STR\(\?title\)\), "energie drop"\)/, "quotes/braces stripped from the literal");
  assert.match(q, /consultation-status\/2>/);
  assert.match(q, /lang\(\?title\) = "fr"/);
  assert.match(q, /LIMIT 50$/);
  assert.ok(!/consultation-status/.test(buildConsultationQuery({ language: "de", limit: 5 }).split("FILTER(lang(?title)")[1].split("?st skos")[0]));
});

// ── Registry & presets ───────────────────────────────────────────────────

test("registry: new modules are registered and every preset names only existing modules", () => {
  const ids = new Set(ALL_MODULES.map((m) => m.id));
  for (const id of ["sanctions", "procurement", "health", "localpolitics", "i14y", "libraries", "glaciers", "cadastre"]) assert.ok(ids.has(id), id);
  for (const [name, mods] of Object.entries(PRESETS)) for (const m of mods) assert.ok(ids.has(m), `${name}: ${m}`);
  const names = ALL_MODULES.flatMap((m) => m.tools.map((t) => t.name));
  assert.equal(new Set(names).size, names.length, "tool names are unique");
});
