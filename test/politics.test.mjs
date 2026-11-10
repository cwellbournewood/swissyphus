/**
 * Offline tests for the politics & law extensions: Curia Vista (parliament)
 * speeches, interests, committees, groups; Fedlex treaties, legislation
 * changes and Federal Gazette. globalThis.fetch is stubbed with recorded-style
 * fixtures shaped like the real OData v2 / SPARQL JSON responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parliamentModule,
  htmlToText,
  excerptAround,
  escapeOData,
  odataNumberLiteral,
  odataDateTime,
  normaliseSpeech,
  normaliseMeetingDate,
  normaliseInterest,
  councilOf,
  matchCommittees,
  isCurrent,
  aggregateGroups,
  dedupeMembers,
  clampKeywordWindow,
} from "../dist/modules/parliament.js";
import {
  lawModule,
  buildTreatyQuery,
  buildChangesQuery,
  buildGazetteQuery,
  gazetteReference,
  safeSrPrefix,
  safeIsoDate,
  compareSr,
  uniqueBy,
} from "../dist/modules/law.js";

// ── fetch stub ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
/** Install a router: (url: URL) => object | undefined (undefined → 404). Returns the list of requested URLs. */
function stubFetch(router) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(url);
    const body = router(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
function toolByName(mod, name) {
  const t = mod.tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
}
function parse(result) {
  return JSON.parse(result.content[0].text);
}
const entityOf = (url) => url.pathname.split("/").pop();
const sparqlOf = (url) => url.searchParams.get("query") ?? "";

// ── Fixtures (shape as returned by ws.parlament.ch/odata.svc with $format=json) ─

const TRANSCRIPTS = {
  d: [
    {
      __metadata: { uri: "https://ws.parlament.ch/odata.svc/Transcript(ID='1',Language='DE')", type: "itsystems.Pd.DataServices.DataModel.Transcript" },
      ID: "123456",
      Language: "DE",
      IdSubject: "56789",
      VoteId: null,
      PersonNumber: 4057,
      Type: 1,
      Text: "<pd_text><p>Frau Präsidentin, der <b>Datenschutz</b> ist zentral &amp; wichtig.</p><p>Deshalb stimme ich zu.</p></pd_text>",
      MeetingCouncilAbbreviation: "S",
      MeetingDate: "20231204",
      IdSession: 5201,
      SpeakerFirstName: "Ruedi",
      SpeakerLastName: "Noser",
      SpeakerFullName: "Ruedi Noser",
      SpeakerFunction: "Mitglied",
      CouncilName: "Ständerat",
      CantonAbbreviation: "ZH",
      ParlGroupAbbreviation: "RL",
      Start: "/Date(1701684000000)/",
      End: "/Date(1701684300000)/",
      SortOrder: 12,
    },
    // duplicate row (e.g. from a fan-out) must be de-duplicated
    { ID: "123456", Language: "DE", SpeakerFullName: "Ruedi Noser", Text: "<p>x</p>", IdSubject: "56789" },
  ],
};
const SUBJECT_BUSINESS = {
  d: [{ IdSubject: "56789", BusinessNumber: 20220045, BusinessShortNumber: "22.045", Title: "Datenschutzgesetz. Änderung", Language: "DE" }],
};
const MEMBERS = {
  d: {
    results: [
      { ID: 4057, PersonNumber: 4057, Language: "DE", FirstName: "Ruedi", LastName: "Noser", PartyAbbreviation: "FDP", ParlGroupAbbreviation: "RL", ParlGroupName: "FDP-Liberale Fraktion", CantonAbbreviation: "ZH", CouncilAbbreviation: "SR", Active: false },
      { ID: 4200, PersonNumber: 4200, Language: "DE", FirstName: "Anna", LastName: "Muster", PartyAbbreviation: "SP", ParlGroupAbbreviation: "S", ParlGroupName: "Sozialdemokratische Fraktion", CantonAbbreviation: "BE", CouncilAbbreviation: "NR", Active: true },
      { ID: 4201, PersonNumber: 4201, Language: "DE", FirstName: "Beat", LastName: "Beispiel", PartyAbbreviation: "SVP", ParlGroupAbbreviation: "V", ParlGroupName: "Fraktion der Schweizerischen Volkspartei", CantonAbbreviation: "AG", CouncilAbbreviation: "NR", Active: true },
      { ID: 4202, PersonNumber: 4202, Language: "DE", FirstName: "Carla", LastName: "Test", PartyAbbreviation: "SVP", ParlGroupAbbreviation: "V", ParlGroupName: "Fraktion der Schweizerischen Volkspartei", CantonAbbreviation: "SZ", CouncilAbbreviation: "SR", Active: true },
      { ID: 4203, PersonNumber: 4203, Language: "DE", FirstName: "Dora", LastName: "Probe", PartyAbbreviation: "Lega", ParlGroupAbbreviation: "V", ParlGroupName: "Fraktion der Schweizerischen Volkspartei", CantonAbbreviation: "TI", CouncilAbbreviation: "NR", Active: true },
    ],
  },
};
const INTERESTS = {
  d: [
    { ID: 1, Language: "DE", PersonNumber: 4057, InterestName: "Swiss Tech Verband", InterestTypeText: "Verwaltungsräte", FunctionInAgencyText: "Präsident", OrganizationTypeText: "Aktiengesellschaft", PersonInterestPaid: 1, SortOrder: 2 },
    { ID: 2, Language: "DE", PersonNumber: 4057, InterestName: "Stiftung Beispiel", InterestTypeText: "Stiftungsräte", FunctionInAgencyText: "Mitglied", OrganizationTypeText: "Stiftung", PersonInterestPaid: 0, SortOrder: 1 },
  ],
};
const OCCUPATIONS = { d: [{ PersonNumber: 4057, OccupationName: "Unternehmer", Employer: "Noser Group", JobTitle: "VR-Präsident" }] };
const COMMITTEES = {
  d: [
    { ID: 5, CommitteeNumber: 5, Language: "DE", CommitteeName: "Kommission für Wirtschaft und Abgaben NR", Abbreviation1: "WAK-N", Abbreviation2: "CER-N", CouncilAbbreviation: "NR", CommitteeTypeName: "Legislativkommission" },
    { ID: 6, CommitteeNumber: 6, Language: "DE", CommitteeName: "Kommission für Wirtschaft und Abgaben SR", Abbreviation1: "WAK-S", Abbreviation2: "CER-E", CouncilAbbreviation: "SR", CommitteeTypeName: "Legislativkommission" },
    { ID: 99, CommitteeNumber: 99, Language: "DE", CommitteeName: "Alte Spezialkommission", Abbreviation1: "SPK-X", CouncilAbbreviation: "NR", EndDate: "/Date(946684800000)/" },
    { ID: 51, CommitteeNumber: 51, Language: "DE", CommitteeName: "Subkommission Steuern", Abbreviation1: "WAK-N-1", CouncilAbbreviation: "NR", SubCommitteeNumber: 1 },
  ],
};
const COMMITTEE_MEMBERS = {
  d: [
    { CommitteeNumber: 5, PersonNumber: 4201, FirstName: "Beat", LastName: "Beispiel", CommitteeFunctionName: "Mitglied", PartyAbbreviation: "SVP", ParlGroupAbbreviation: "V", CantonAbbreviation: "AG", CouncilAbbreviation: "NR" },
    { CommitteeNumber: 5, PersonNumber: 4200, FirstName: "Anna", LastName: "Muster", CommitteeFunctionName: "Präsidentin", PartyAbbreviation: "SP", ParlGroupAbbreviation: "S", CantonAbbreviation: "BE", CouncilAbbreviation: "NR" },
    { CommitteeNumber: 5, PersonNumber: 3000, FirstName: "Ex", LastName: "Mitglied", CommitteeFunctionName: "Mitglied", CouncilAbbreviation: "NR", DateLeaving: "/Date(1262304000000)/" },
  ],
};

function parliamentRouter(url) {
  switch (entityOf(url)) {
    case "Transcript":
      return TRANSCRIPTS;
    case "SubjectBusiness":
      return SUBJECT_BUSINESS;
    case "MemberCouncil": {
      const f = url.searchParams.get("$filter") ?? "";
      if (f.includes("'Noser'")) return { d: MEMBERS.d.results.filter((m) => m.LastName === "Noser") };
      if (f.includes("'Mu'")) return { d: [MEMBERS.d.results[1], { ...MEMBERS.d.results[1], ID: 4300, PersonNumber: 4300, LastName: "Mumenthaler" }] };
      if (f.includes("Active eq true")) return { d: { results: MEMBERS.d.results.filter((m) => m.Active) } };
      return { d: [] };
    }
    case "PersonInterest":
      return INTERESTS;
    case "PersonOccupation":
      return OCCUPATIONS;
    case "Committee":
      return COMMITTEES;
    case "MemberCommittee":
      return COMMITTEE_MEMBERS;
    default:
      return undefined;
  }
}

// ── Parliament helpers ───────────────────────────────────────────────────

test("parliament: htmlToText strips tags and decodes entities", () => {
  assert.equal(htmlToText("<p>A &amp; B&nbsp;&#252;ber <b>C</b></p>\n<p>D&#x21;</p>"), "A & B über C D!");
  assert.equal(htmlToText("&bogus; &#0;"), "&bogus;");
});

test("parliament: excerptAround centres on the keyword and marks truncation", () => {
  const text = "a ".repeat(300) + "Klimaschutz ist wichtig " + "b ".repeat(300);
  const ex = excerptAround(text, "klimaschutz", 120);
  assert.ok(ex.includes("Klimaschutz"), ex);
  assert.ok(ex.startsWith("… ") && ex.endsWith(" …"), ex);
  assert.ok(ex.length <= 124);
  assert.equal(excerptAround("short", "x", 100), "short");
  assert.ok(excerptAround("x".repeat(500), undefined, 50).endsWith(" …"));
});

test("parliament: OData escaping and literals", () => {
  assert.equal(escapeOData("O'Brien"), "O''Brien");
  assert.equal(escapeOData("') or 1 eq 1 or ('"), "'') or 1 eq 1 or (''");
  assert.equal(odataNumberLiteral(42), "42");
  assert.equal(odataNumberLiteral("56789"), "56789L");
  assert.equal(odataNumberLiteral("12 or 1"), undefined);
  assert.equal(odataNumberLiteral(1.5), undefined);
  assert.equal(odataDateTime("2024-01-31"), "datetime'2024-01-31T00:00:00'");
  assert.equal(odataDateTime("2024-01-31", true), "datetime'2024-01-31T23:59:59'");
  assert.equal(normaliseMeetingDate("20231204"), "2023-12-04");
  assert.equal(normaliseMeetingDate("2023-12-04"), "2023-12-04");
});

test("parliament: normaliseSpeech builds a compact record with Bulletin link", () => {
  const s = normaliseSpeech(TRANSCRIPTS.d[0], "Datenschutz", 400);
  assert.equal(s.speaker, "Ruedi Noser");
  assert.equal(s.person_number, 4057);
  assert.equal(s.council, "Ständerat");
  assert.equal(s.date, "2023-12-04");
  assert.equal(s.parl_group, "RL");
  assert.match(s.excerpt, /Datenschutz ist zentral & wichtig\. Deshalb/);
  assert.equal(
    s.bulletin_url,
    "https://www.parlament.ch/de/ratsbetrieb/amtliches-bulletin/amtliches-bulletin-die-verhandlungen?SubjectId=56789",
  );
  assert.ok(!("Text" in s));
});

test("parliament: normaliseInterest detects paid flag and maps fields", () => {
  const i = normaliseInterest(INTERESTS.d[0]);
  assert.deepEqual(i, {
    organisation: "Swiss Tech Verband",
    function: "Präsident",
    interest_type: "Verwaltungsräte",
    organisation_type: "Aktiengesellschaft",
    paid: true,
  });
  assert.equal(normaliseInterest(INTERESTS.d[1]).paid, false);
  assert.equal(normaliseInterest({ InterestName: "X" }).paid, undefined);
});

test("parliament: councilOf, isCurrent, matchCommittees", () => {
  assert.equal(councilOf({ CouncilAbbreviation: "NR" }), "NR");
  assert.equal(councilOf({ CouncilAbbreviation: "CE" }), "SR");
  assert.equal(councilOf({ Council: 2 }), "SR");
  assert.equal(councilOf({ CouncilName: "Nationalrat" }), "NR");
  assert.equal(councilOf({ Abbreviation1: "SGK-S" }), "SR");
  assert.equal(councilOf({}), undefined);
  assert.equal(isCurrent({ EndDate: "2000-01-01" }), false);
  assert.equal(isCurrent({ EndDate: "2999-01-01" }), true);
  assert.equal(isCurrent({}), true);
  assert.equal(isCurrent({ Active: false }), false);
  const rows = COMMITTEES.d.map((r) => ({ ...r }));
  assert.deepEqual(matchCommittees(rows, "wak-n").map((r) => r.CommitteeNumber), [5]);
  assert.deepEqual(matchCommittees(rows, "CER-E").map((r) => r.CommitteeNumber), [6]);
  assert.deepEqual(matchCommittees(rows, "6").map((r) => r.CommitteeNumber), [6]);
  assert.deepEqual(matchCommittees(rows, "WAK").map((r) => r.CommitteeNumber).sort(), [5, 51, 6]);
  assert.deepEqual(matchCommittees(rows, "Spezial").map((r) => r.CommitteeNumber), [99]);
});

test("parliament: aggregateGroups counts seats per chamber with party breakdown", () => {
  const active = MEMBERS.d.results.filter((m) => m.Active);
  const groups = aggregateGroups(active, "parl_group");
  assert.equal(groups[0].abbreviation, "V");
  assert.equal(groups[0].total, 3);
  assert.deepEqual(groups[0].by_council, { NR: 2, SR: 1 });
  assert.deepEqual(groups[0].breakdown, { SVP: 2, Lega: 1 });
  assert.equal(groups[0].name, "Fraktion der Schweizerischen Volkspartei");
  const parties = aggregateGroups(active, "party");
  assert.equal(parties[0].abbreviation, "SVP");
  assert.deepEqual(parties[0].breakdown, { V: 2 });
});

test("parliament: dedupeMembers keeps one row per person, active first", () => {
  const rows = [
    { ID: 1, PersonNumber: 1, Active: false },
    { ID: 2, PersonNumber: 2, Active: true },
    { ID: 1, PersonNumber: 1, Active: true },
  ];
  const out = dedupeMembers(rows);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.Active === true));
});

// ── Parliament handlers ──────────────────────────────────────────────────

test("search_parliament_speeches: filters, dedupes, enriches with business", async () => {
  const calls = stubFetch(parliamentRouter);
  try {
    const res = await toolByName(parliamentModule, "search_parliament_speeches").handler({
      speaker: "Noser",
      keyword: "Daten'schutz",
      date_from: "2023-01-01",
      date_to: "2024-06-30",
      language: "DE",
      excerpt_chars: 300,
      limit: 5,
    });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    assert.equal(body.data.count, 1);
    const sp = body.data.speeches[0];
    assert.equal(sp.speaker, "Ruedi Noser");
    assert.deepEqual(sp.business, [{ short_number: "22.045", title: "Datenschutzgesetz. Änderung", business_id: 20220045 }]);
    const f = calls[0].searchParams.get("$filter");
    assert.equal(entityOf(calls[0]), "Transcript");
    assert.ok(f.includes("substringof('Noser', SpeakerFullName)"), f);
    assert.ok(f.includes("substringof('Daten''schutz', Text)"), f);
    assert.ok(f.includes("Start ge datetime'2023-01-01T00:00:00'"), f);
    assert.equal(calls[0].searchParams.get("$orderby"), "Start desc");
    const sf = calls[1].searchParams.get("$filter");
    assert.ok(sf.includes("IdSubject eq 56789L"), sf);
    assert.equal(body.source.operator, "Parliamentary Services of the Federal Assembly");
  } finally {
    restoreFetch();
  }
});

test("search_parliament_speeches: requires a criterion; keyword-only gets a default window", async () => {
  const t = toolByName(parliamentModule, "search_parliament_speeches");
  const err = await t.handler({ language: "DE", excerpt_chars: 300, limit: 5 });
  assert.equal(err.isError, true);
  const calls = stubFetch(parliamentRouter);
  try {
    const res = await t.handler({ keyword: "Neutralität", language: "DE", excerpt_chars: 300, limit: 3 });
    assert.ok(!res.isError);
    assert.match(parse(res).notes, /Keyword search limited/);
    assert.ok(calls[0].searchParams.get("$filter").includes("Start ge datetime'"));
  } finally {
    restoreFetch();
  }
});

test("clampKeywordWindow: keyword searches never span more than 2 years", () => {
  // No dates → 2 years back from today.
  const d = clampKeywordWindow(undefined, undefined, "2026-09-26");
  assert.equal(d.from, "2024-09-26");
  assert.match(d.note, /max 2 years/);
  // An old date_from is moved forward, with a note.
  const old = clampKeywordWindow("1990-01-01", undefined, "2026-09-26");
  assert.equal(old.from, "2024-09-26");
  assert.match(old.note, /date_from moved from 1990-01-01 to 2024-09-26/);
  // date_to alone anchors the window.
  assert.equal(clampKeywordWindow(undefined, "2000-12-31", "2026-09-26").from, "1999-01-01");
  // A window already ≤ 2 years is untouched and silent.
  assert.deepEqual(clampKeywordWindow("1999-03-01", "2000-12-31", "2026-09-26"), { from: "1999-03-01" });
});

test("search_parliament_speeches: keyword + old date_from is clamped (even with a speaker)", async () => {
  const t = toolByName(parliamentModule, "search_parliament_speeches");
  const calls = stubFetch(parliamentRouter);
  try {
    const res = await t.handler({ speaker: "Noser", keyword: "Datenschutz", date_from: "1990-01-01", language: "DE", excerpt_chars: 300, limit: 3 });
    assert.ok(!res.isError, res.content[0].text);
    assert.match(parse(res).notes, /date_from moved from 1990-01-01/);
    const f = calls[0].searchParams.get("$filter");
    assert.ok(!f.includes("datetime'1990-01-01"), f);
    const m = /Start ge datetime'(\d{4}-\d{2}-\d{2})/.exec(f);
    assert.ok(m && Date.now() - Date.parse(m[1]) <= 731 * 86_400_000, f);
    // Speaker-only searches are not clamped (no full-text scan).
    calls.length = 0;
    await t.handler({ speaker: "Noser", date_from: "1990-01-01", language: "DE", excerpt_chars: 300, limit: 3 });
    assert.ok(calls[0].searchParams.get("$filter").includes("Start ge datetime'1990-01-01T00:00:00'"));
    const bad = await t.handler({ keyword: "Datenschutz", date_from: "2024-05-01", date_to: "2024-01-01", language: "DE", excerpt_chars: 300, limit: 3 });
    assert.equal(bad.isError, true);
  } finally {
    restoreFetch();
  }
});

test("get_member_interests: resolves name, returns interests + occupations", async () => {
  const calls = stubFetch(parliamentRouter);
  try {
    const res = await toolByName(parliamentModule, "get_member_interests").handler({
      name: "Noser",
      include_occupations: true,
      language: "DE",
      limit: 50,
    });
    assert.ok(!res.isError, res.content[0].text);
    const d = parse(res).data;
    assert.equal(d.person_number, 4057);
    assert.equal(d.member.name, "Ruedi Noser");
    assert.equal(d.interest_count, 2);
    assert.equal(d.interests[0].organisation, "Stiftung Beispiel"); // SortOrder 1 first
    assert.equal(d.interests[1].paid, true);
    assert.equal(d.occupations[0].employer, "Noser Group");
    const pi = calls.find((u) => entityOf(u) === "PersonInterest");
    assert.ok(pi.searchParams.get("$filter").includes("PersonNumber eq 4057"));
  } finally {
    restoreFetch();
  }
});

test("get_member_interests: ambiguous name lists candidates", async () => {
  stubFetch(parliamentRouter);
  try {
    const res = await toolByName(parliamentModule, "get_member_interests").handler({
      name: "Mu",
      include_occupations: false,
      language: "DE",
      limit: 50,
    });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.match(body.error, /matches 2 people/);
    assert.ok(body.suggestions.some((s) => s.includes("person_number=4200")));
  } finally {
    restoreFetch();
  }
});

test("list_parliament_committees: filters inactive, subcommittees and council", async () => {
  stubFetch(parliamentRouter);
  try {
    const t = toolByName(parliamentModule, "list_parliament_committees");
    const all = parse(await t.handler({ council: "all", include_inactive: false, include_subcommittees: false, language: "DE", limit: 50 }));
    assert.deepEqual(all.data.committees.map((c) => c.abbreviation), ["WAK-N", "WAK-S"]);
    const sr = parse(await t.handler({ council: "SR", include_inactive: false, include_subcommittees: false, language: "DE", limit: 50 }));
    assert.deepEqual(sr.data.committees.map((c) => c.committee_number), [6]);
  } finally {
    restoreFetch();
  }
});

test("get_committee_members: resolves abbreviation and drops former members", async () => {
  const calls = stubFetch(parliamentRouter);
  try {
    const res = await toolByName(parliamentModule, "get_committee_members").handler({ committee: "WAK-N", language: "DE", limit: 60 });
    assert.ok(!res.isError, res.content[0].text);
    const d = parse(res).data;
    assert.equal(d.committee.abbreviation, "WAK-N");
    assert.equal(d.member_count, 2);
    assert.equal(d.members[0].function, "Präsidentin");
    const mc = calls.find((u) => entityOf(u) === "MemberCommittee");
    assert.ok(mc.searchParams.get("$filter").includes("CommitteeNumber eq 5"));
    const amb = await toolByName(parliamentModule, "get_committee_members").handler({ committee: "Wirtschaft", language: "DE", limit: 60 });
    assert.equal(amb.isError, true);
  } finally {
    restoreFetch();
  }
});

test("list_parliamentary_groups: aggregates active members", async () => {
  stubFetch(parliamentRouter);
  try {
    const res = await toolByName(parliamentModule, "list_parliamentary_groups").handler({ by: "parl_group", council: "all", language: "DE" });
    const d = parse(res).data;
    assert.equal(d.total_members, 4);
    assert.deepEqual(d.seats_by_council, { NR: 3, SR: 1 });
    assert.equal(d.groups[0].abbreviation, "V");
  } finally {
    restoreFetch();
  }
});

// ── Law helpers ──────────────────────────────────────────────────────────

test("law: SR prefix / date validation and ordering", () => {
  assert.equal(safeSrPrefix("0.142"), "0.142");
  assert.equal(safeSrPrefix("0."), "0.");
  assert.equal(safeSrPrefix('0") } ?x'), undefined);
  assert.equal(safeIsoDate("2024-02-29"), "2024-02-29");
  assert.equal(safeIsoDate('2024-01-01"'), undefined);
  const srs = ["3", "0.2", "220", "0.142.111", "0.142.2", "235.1", "235.11"];
  assert.deepEqual([...srs].sort(compareSr), ["0.142.111", "0.142.2", "0.2", "220", "235.1", "235.11", "3"]);
  assert.equal(gazetteReference("https://fedlex.data.admin.ch/eli/fga/2024/1234", "de"), "BBl 2024 1234");
  assert.equal(gazetteReference("https://fedlex.data.admin.ch/eli/fga/2024/1234", "fr"), "FF 2024 1234");
  assert.equal(gazetteReference("https://fedlex.data.admin.ch/eli/cc/27/317_321_377", "de"), undefined);
  assert.equal(uniqueBy([{ a: { value: "1" } }, { a: { value: "1" } }, { a: { value: "2" } }, {}], "a").length, 2);
});

test("law: query builders sanitize user input and bound the query", () => {
  const q = buildTreatyQuery({ query: 'Doppel" } ; DROP ALL #', language: "de", inForceOnly: true, limit: 500 });
  assert.ok(!q.includes('Doppel"'), q);
  assert.ok(q.includes('"doppel drop all"'), q);
  assert.ok(q.includes('STRSTARTS(STR(?srNotation), "0.")'));
  assert.match(q, /LIMIT 100$/);
  // A non-treaty prefix is ignored; the tool never leaves the 0.* space.
  assert.ok(buildTreatyQuery({ srPrefix: "2", language: "de", inForceOnly: false, limit: 5 }).includes('"0."'));
  const c = buildChangesQuery({ kind: "repealed", from: "2025-01-01", to: "2025-01-31", language: "fr", srPrefix: "8", limit: 10 });
  assert.ok(c.includes("jolux:dateNoLongerInForce ?d"));
  assert.ok(c.includes('>= "2025-01-01"') && c.includes('<= "2025-01-31"'));
  assert.ok(c.includes("language/FRA"));
  assert.ok(buildChangesQuery({ kind: "amended", from: "2025-01-01", to: "2025-01-31", language: "de", limit: 1 }).includes("jolux:isMemberOf ?consoAbstract"));
  assert.throws(() => buildChangesQuery({ kind: "amended", from: '2025"', to: "2025-01-31", language: "de", limit: 1 }));
  const g = buildGazetteQuery({ from: "2025-01-01", to: "2025-03-31", language: "it", query: "energia", limit: 5 });
  assert.ok(g.includes('STRSTARTS(STR(?act), "https://fedlex.data.admin.ch/eli/fga/")'));
  assert.ok(g.includes('CONTAINS(LCASE(STR(?title)), "energia")'));
  assert.throws(() => buildGazetteQuery({ from: "x", to: "2025-01-01", language: "de", limit: 5 }));
});

// ── Law handlers ─────────────────────────────────────────────────────────

const B = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: "literal", value: v }]));

test("search_international_treaties: parses bindings, dedupes and sorts by SR", async () => {
  const calls = stubFetch((url) => {
    assert.equal(url.hostname, "fedlex.data.admin.ch");
    return {
      head: { vars: ["consoAbstract", "sr", "titleStr", "abbrStr", "entryInForce", "endDate"] },
      results: {
        bindings: [
          B({ consoAbstract: "https://fedlex.data.admin.ch/eli/cc/2011/1", sr: "0.672.913.62", titleStr: "Abkommen zwischen der Schweiz und Deutschland zur Vermeidung der Doppelbesteuerung", abbrStr: "", entryInForce: "1972-12-29", endDate: "" }),
          B({ consoAbstract: "https://fedlex.data.admin.ch/eli/cc/2011/1", sr: "0.672.913.62", titleStr: "dup", abbrStr: "", entryInForce: "1972-12-29", endDate: "" }),
          B({ consoAbstract: "https://fedlex.data.admin.ch/eli/cc/2011/2", sr: "0.672.913.2", titleStr: "Abkommen … Dänemark … Doppelbesteuerung", abbrStr: "", entryInForce: "", endDate: "" }),
        ],
      },
    };
  });
  try {
    const res = await toolByName(lawModule, "search_international_treaties").handler({
      query: "Doppelbesteuerung",
      language: "de",
      in_force_only: true,
      limit: 10,
    });
    assert.ok(!res.isError, res.content[0].text);
    const d = parse(res).data;
    assert.equal(d.count, 2);
    assert.equal(d.results[0].sr_number, "0.672.913.2");
    assert.equal(d.results[1].entry_into_force, "1972-12-29");
    assert.equal(d.results[1].fedlex_url, "https://www.fedlex.admin.ch/eli/cc/2011/1/de");
    assert.ok(sparqlOf(calls[0]).includes('"doppelbesteuerung"'));
    const none = await toolByName(lawModule, "search_international_treaties").handler({ language: "de", in_force_only: true, limit: 5 });
    assert.equal(none.isError, true);
  } finally {
    restoreFetch();
  }
});

test("list_recent_legislation_changes: default window and parsing", async () => {
  const calls = stubFetch(() => ({
    results: {
      bindings: [
        B({ consoAbstract: "https://fedlex.data.admin.ch/eli/cc/1995/1328_1328_1328", sr: "832.10", titleStr: "Bundesgesetz über die Krankenversicherung", date: "2025-01-01" }),
        B({ consoAbstract: "https://fedlex.data.admin.ch/eli/cc/1995/1328_1328_1328", sr: "832.10", titleStr: "Bundesgesetz über die Krankenversicherung", date: "2025-01-01" }),
      ],
    },
  }));
  try {
    const t = toolByName(lawModule, "list_recent_legislation_changes");
    const res = await t.handler({ change: "amended", sr_prefix: "8", language: "de", limit: 30 });
    assert.ok(!res.isError, res.content[0].text);
    const d = parse(res).data;
    assert.equal(d.count, 1);
    assert.equal(d.changes[0].sr_number, "832.10");
    assert.ok(sparqlOf(calls[0]).includes("jolux:dateApplicability ?d"));
    const bad = await t.handler({ change: "amended", date_from: "2020-01-01", date_to: "2025-01-01", language: "de", limit: 5 });
    assert.equal(bad.isError, true);
  } finally {
    restoreFetch();
  }
});

test("search_federal_gazette: returns BBl references and uses the gazette source", async () => {
  const calls = stubFetch(() => ({
    results: {
      bindings: [
        B({ act: "https://fedlex.data.admin.ch/eli/fga/2025/123", date: "2025-02-14", titleStr: "Botschaft zur Änderung des Energiegesetzes" }),
      ],
    },
  }));
  try {
    const res = await toolByName(lawModule, "search_federal_gazette").handler({ query: "Botschaft", date_from: "2025-01-01", date_to: "2025-03-31", language: "de", limit: 5 });
    assert.ok(!res.isError, res.content[0].text);
    const body = parse(res);
    assert.equal(body.data.results[0].reference, "BBl 2025 123");
    assert.equal(body.data.results[0].fedlex_url, "https://www.fedlex.admin.ch/eli/fga/2025/123/de");
    assert.match(body.source.name, /Federal Gazette/);
    assert.ok(sparqlOf(calls[0]).includes('"botschaft"'));
  } finally {
    restoreFetch();
  }
});

test("search_federal_gazette: rejects date ranges wider than 2 years without querying", async () => {
  const calls = stubFetch(() => ({ results: { bindings: [] } }));
  try {
    const t = toolByName(lawModule, "search_federal_gazette");
    const res = await t.handler({ query: "Botschaft", date_from: "1990-01-01", language: "de", limit: 5 });
    assert.equal(res.isError, true);
    assert.match(parse(res).error, /max 2 years/);
    const res2 = await t.handler({ date_from: "2010-01-01", date_to: "2015-01-01", language: "de", limit: 5 });
    assert.equal(res2.isError, true);
    assert.equal(calls.length, 0);
    // An old date_to alone defaults the window relative to it (not to today).
    await t.handler({ query: "Botschaft", date_to: "2001-12-31", language: "de", limit: 5 });
    assert.equal(calls.length, 1);
    assert.ok(sparqlOf(calls[0]).includes("2000-01-01"), sparqlOf(calls[0]));
  } finally {
    restoreFetch();
  }
});

test("upstream failure surfaces as a graceful tool error", async () => {
  stubFetch(() => undefined);
  try {
    const res = await toolByName(lawModule, "search_federal_gazette").handler({ query: "nichtvorhanden", language: "de", limit: 5 });
    assert.equal(res.isError, true);
    assert.match(JSON.parse(res.content[0].text).error, /Fedlex SPARQL endpoint is currently unavailable/);
  } finally {
    restoreFetch();
  }
});

test("modules: new tool names are unique and existing tools are retained", () => {
  const names = [...parliamentModule.tools, ...lawModule.tools].map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of [
    "search_parliament_business",
    "get_parliament_business",
    "get_session_schedule",
    "get_parliament_votes",
    "search_council_members",
    "search_federal_law",
    "get_law_by_sr",
    "search_parliament_speeches",
    "get_member_interests",
    "list_parliament_committees",
    "get_committee_members",
    "list_parliamentary_groups",
    "search_international_treaties",
    "list_recent_legislation_changes",
    "search_federal_gazette",
  ]) {
    assert.ok(names.includes(n), n);
  }
});
