/**
 * Offline tests for the compliance modules: UID register (SOAP/XML) and
 * court decisions (entscheidsuche.ch Elasticsearch). globalThis.fetch is
 * stubbed with recorded-style fixtures and always restored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  uidModule,
  uidCheckDigit,
  normaliseUid,
  xmlEscape,
  parseXml,
  findFirst,
  findAll,
  textOf,
  extractRecords,
  extractBoolean,
  getByUidEnvelope,
  searchEnvelope,
} from "../dist/modules/uid.js";
import {
  courtsModule,
  buildSearchQuery,
  normaliseHit,
  pickLang,
  resolveDocUrl,
  htmlToText,
  courtCodes,
  endOfPeriod,
  totalOf,
} from "../dist/modules/courts.js";

const toolOf = (mod, name) => mod.tools.find((t) => t.name === name);
const body = (r) => JSON.parse(r.content[0].text);

async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

// ---------------------------------------------------------------------------
// UID fixtures (shape of WCF/UID-WSE V5.0 responses: default + prefixed namespaces, i:nil)
// ---------------------------------------------------------------------------

const GET_BY_UID_XML = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetByUIDResponse xmlns="http://www.uid.admin.ch/xmlns/uid-wse">
      <GetByUIDResult xmlns:a="http://www.ech.ch/xmlns/eCH-0108/5" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <a:organisationType>
          <a:organisation>
            <b:organisationIdentification xmlns:b="http://www.ech.ch/xmlns/eCH-0098/5">
              <c:uid xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5">
                <c:uidOrganisationIdCategorie>CHE</c:uidOrganisationIdCategorie>
                <c:uidOrganisationId>107028276</c:uidOrganisationId>
              </c:uid>
              <c:localOrganisationId xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5">
                <c:organisationIdCategory>CH.HR</c:organisationIdCategory>
                <c:organisationId>CH02030001234</c:organisationId>
              </c:localOrganisationId>
              <c:organisationName xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5">Muster &amp; Söhne AG</c:organisationName>
              <c:organisationLegalName xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5"><![CDATA[Muster & Söhne AG <Zürich>]]></c:organisationLegalName>
              <c:legalForm xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5">0105</c:legalForm>
            </b:organisationIdentification>
            <b:address xmlns:b="http://www.ech.ch/xmlns/eCH-0098/5">
              <!-- postal address -->
              <d:addressInformation xmlns:d="http://www.ech.ch/xmlns/eCH-0010/6">
                <d:street>Bahnhofstrasse</d:street>
                <d:houseNumber>1</d:houseNumber>
                <d:town>Zürich</d:town>
                <d:swissZipCode>8001</d:swissZipCode>
                <d:countryIdISO2>CH</d:countryIdISO2>
              </d:addressInformation>
              <b:municipalityId>261</b:municipalityId>
              <b:cantonAbbreviation>ZH</b:cantonAbbreviation>
            </b:address>
          </a:organisation>
          <a:uidregInformation>
            <a:uidregStatusEnterpriseDetail>3</a:uidregStatusEnterpriseDetail>
            <a:uidregPublicStatus>1</a:uidregPublicStatus>
            <a:uidregOrganisationType>1</a:uidregOrganisationType>
            <a:uidregLiquidationDate i:nil="true"/>
          </a:uidregInformation>
          <a:vatRegisterInformation>
            <a:vatStatus>2</a:vatStatus>
            <a:vatEntryStatus>1</a:vatEntryStatus>
            <a:uidVat>
              <c:uidOrganisationIdCategorie xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5">CHE</c:uidOrganisationIdCategorie>
              <c:uidOrganisationId xmlns:c="http://www.ech.ch/xmlns/eCH-0097/5">107028276</c:uidOrganisationId>
            </a:uidVat>
            <a:vatEntryDate>1995-01-01</a:vatEntryDate>
            <a:vatLiquidationDate i:nil="true"/>
          </a:vatRegisterInformation>
          <a:commercialRegisterInformation>
            <a:commercialRegisterStatus>2</a:commercialRegisterStatus>
            <a:commercialRegisterEntryStatus>1</a:commercialRegisterEntryStatus>
            <a:commercialRegisterEntryDate>1990-05-04</a:commercialRegisterEntryDate>
          </a:commercialRegisterInformation>
        </a:organisationType>
      </GetByUIDResult>
    </GetByUIDResponse>
  </s:Body>
</s:Envelope>`;

function searchItem(uid, name, legalForm, zip, town, canton, rating) {
  return `<a:uidEntitySearchResultItem>
    <a:organisation>
      <b:organisation>
        <b:organisationIdentification>
          <c:uid><c:uidOrganisationIdCategorie>CHE</c:uidOrganisationIdCategorie><c:uidOrganisationId>${uid}</c:uidOrganisationId></c:uid>
          <c:organisationName>${name}</c:organisationName>
          <c:legalForm>${legalForm}</c:legalForm>
        </b:organisationIdentification>
        <b:address><d:addressInformation><d:town>${town}</d:town><d:swissZipCode>${zip}</d:swissZipCode><d:countryIdISO2>CH</d:countryIdISO2></d:addressInformation>${canton ? `<b:cantonAbbreviation>${canton}</b:cantonAbbreviation>` : ""}</b:address>
      </b:organisation>
    </a:organisation>
    <a:rating>${rating}</a:rating>
  </a:uidEntitySearchResultItem>`;
}

const SEARCH_XML = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<SearchResponse xmlns="http://www.uid.admin.ch/xmlns/uid-wse"><SearchResult xmlns:a="x" xmlns:b="y" xmlns:c="z" xmlns:d="w">
${searchItem("116281710", "Verein Pro Velo Bern", "0109", "3011", "Bern", "BE", 100)}
${searchItem("107028276", "Pro Velo Zürich", "0109", "8004", "Zürich", "ZH", 90)}
${searchItem("105829940", "Pro Velo Schweiz", "0109", "3001", "Bern", undefined, 80)}
</SearchResult></SearchResponse></s:Body></s:Envelope>`;

const VALIDATE_VAT_XML = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<ValidateVatNumberResponse xmlns="http://www.uid.admin.ch/xmlns/uid-wse"><ValidateVatNumberResult>true</ValidateVatNumberResult></ValidateVatNumberResponse>
</s:Body></s:Envelope>`;

// ---------------------------------------------------------------------------
// UID: pure helpers
// ---------------------------------------------------------------------------

test("uid: check digit uses mod 11 with weights 5,4,3,2,7,6,5,4", () => {
  assert.equal(uidCheckDigit("10702827"), 6); // CHE-107.028.276
  assert.equal(uidCheckDigit("1234567"), null);
  // A prefix whose weighted sum gives remainder 1 → check value 10 → never issued.
  // 00000003: 3*4 = 12 → 12 mod 11 = 1 → 11-1 = 10
  assert.equal(uidCheckDigit("00000003"), null);
  // remainder 0 → check digit 0: 00000000
  assert.equal(uidCheckDigit("00000000"), 0);
});

test("uid: normaliseUid accepts common formats and validates", () => {
  for (const s of ["CHE-107.028.276", "che107028276", "CHE 107 028 276", "107028276", "107.028.276", "CHE-107.028.276 MWST"]) {
    const n = normaliseUid(s);
    assert.ok(n, s);
    assert.equal(n.formatted, "CHE-107.028.276", s);
    assert.equal(n.valid, true, s);
  }
  assert.equal(normaliseUid("CHE-107.028.276 TVA").vatSuffix, "TVA");
  assert.equal(normaliseUid("CHE107028276IVA").vatSuffix, "IVA");
  const bad = normaliseUid("CHE-107.028.277");
  assert.equal(bad.valid, false);
  assert.match(bad.error, /expected 6/);
  assert.equal(normaliseUid("CHE-12.345"), null);
  assert.equal(normaliseUid("DE123456789"), null);
});

test("uid: xmlEscape neutralises markup and drops illegal control chars", () => {
  assert.equal(xmlEscape(`a<b>&"c'\u0001`), "a&lt;b&gt;&amp;&quot;c&apos;");
  const env = searchEnvelope(`</shared:organisationName><evil/>`);
  assert.ok(!env.includes("<evil/>"));
  assert.ok(env.includes("&lt;evil/&gt;"));
  const g = getByUidEnvelope(normaliseUid("CHE-107.028.276"));
  assert.match(g, /<ech0097:uidOrganisationIdCategorie>CHE<\/ech0097:uidOrganisationIdCategorie>/);
  assert.match(g, /<ech0097:uidOrganisationId>107028276<\/ech0097:uidOrganisationId>/);
});

test("uid: parseXml strips prefixes, decodes entities/CDATA, handles nil, comments, self-closing", () => {
  const doc = parseXml(GET_BY_UID_XML);
  assert.equal(textOf(doc, "organisationName"), "Muster & Söhne AG");
  assert.equal(textOf(doc, "organisationLegalName"), "Muster & Söhne AG <Zürich>");
  assert.equal(textOf(doc, "vatLiquidationDate"), undefined);
  assert.equal(findFirst(doc, "vatLiquidationDate").attrs.nil, "true");
  assert.equal(findAll(doc, "uidOrganisationId").length, 2);
  // Tolerates stray close tags and unclosed elements.
  const messy = parseXml(`<a><b>x</c></b><d attr='1 > 0'>&#x41;&#66;<e/></a><f>`);
  assert.equal(textOf(messy, "b"), "x");
  assert.equal(findFirst(messy, "d").attrs.attr, "1 > 0");
  assert.equal(textOf(messy, "d"), "AB");
  assert.ok(findFirst(messy, "f"));
});

test("uid: extractRecords maps a GetByUID response", () => {
  const [r, ...rest] = extractRecords(parseXml(GET_BY_UID_XML));
  assert.equal(rest.length, 0);
  assert.equal(r.uid, "CHE-107.028.276");
  assert.equal(r.name, "Muster & Söhne AG");
  assert.equal(r.legal_form_code, "0105");
  assert.equal(r.legal_form, "Company limited by shares (AG/SA)");
  assert.deepEqual(r.address, {
    street: "Bahnhofstrasse",
    house_number: "1",
    postcode: "8001",
    town: "Zürich",
    municipality_bfs_id: "261",
    canton: "ZH",
    country: "CH",
  });
  assert.equal(r.vat.registered, true);
  assert.equal(r.vat.vat_number, "CHE-107.028.276 MWST");
  assert.equal(r.vat.entry_date, "1995-01-01");
  assert.equal(r.commercial_register.status_code, "2");
  assert.equal(r.uid_register.status_code, "3");
});

test("uid: extractRecords splits search results and reads ratings; extractBoolean", () => {
  const recs = extractRecords(parseXml(SEARCH_XML));
  assert.equal(recs.length, 3);
  assert.equal(recs[0].uid, "CHE-116.281.710");
  assert.equal(recs[0].match_rating, 100);
  assert.equal(recs[2].address.canton, undefined);
  assert.equal(recs[1].vat.registered, false);
  assert.equal(extractBoolean(parseXml(VALIDATE_VAT_XML), "ValidateVatNumber"), true);
});

// ---------------------------------------------------------------------------
// UID: handler paths
// ---------------------------------------------------------------------------

test("uid: lookup_uid posts a SOAP 1.1 request and returns the envelope", async () => {
  const calls = [];
  const r = await withFetch(
    async (url, init) => {
      calls.push({ url, init });
      return new Response(GET_BY_UID_XML, { status: 200, headers: { "content-type": "text/xml" } });
    },
    () => toolOf(uidModule, "lookup_uid").handler({ uid: "che 107 028 276" }),
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.uid-wse.admin.ch/V5.0/PublicServices.svc");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.SOAPAction, '"http://www.uid.admin.ch/xmlns/uid-wse/IPublicServices/GetByUID"');
  assert.match(calls[0].init.headers["Content-Type"], /text\/xml/);
  const b = body(r);
  assert.equal(b.data.entity.name, "Muster & Söhne AG");
  assert.equal(b.data.entity.vat.registered, true);
  assert.equal(b.source.operator, "Federal Statistical Office (FSO/BFS)");
});

test("uid: lookup_uid rejects a bad check digit without any network call", async () => {
  let called = false;
  const r = await withFetch(
    async () => {
      called = true;
      return new Response("", { status: 500 });
    },
    () => toolOf(uidModule, "lookup_uid").handler({ uid: "CHE-107.028.277" }),
  );
  assert.equal(r.isError, true);
  assert.equal(called, false);
  assert.match(body(r).error, /not a valid UID/);
});

test("uid: search_uid_register filters by canton client-side (keeping unknown-canton records)", async () => {
  const r = await withFetch(
    async (_url, init) => {
      assert.match(init.body, /<shared:organisationName>Pro Velo<\/shared:organisationName>/);
      return new Response(SEARCH_XML, { status: 200 });
    },
    () => toolOf(uidModule, "search_uid_register").handler({ name: "Pro Velo", canton: "be", limit: 10 }),
  );
  const b = body(r);
  assert.equal(b.data.total_returned, 3);
  assert.deepEqual(
    b.data.results.map((x) => x.name),
    ["Verein Pro Velo Bern", "Pro Velo Schweiz"],
  );
  assert.ok(b.notes);
});

test("uid: validate_vat_number uses ValidateVatNumber and GetByUID details", async () => {
  const actions = [];
  const r = await withFetch(
    async (_url, init) => {
      actions.push(init.headers.SOAPAction);
      if (init.headers.SOAPAction.includes("ValidateVatNumber")) {
        assert.match(init.body, /<uid:vatNumber>CHE-116\.281\.710<\/uid:vatNumber>/);
        return new Response(VALIDATE_VAT_XML, { status: 200 });
      }
      return new Response(GET_BY_UID_XML, { status: 200 });
    },
    () => toolOf(uidModule, "validate_vat_number").handler({ vat_number: "CHE116281710 TVA", include_details: true }),
  );
  const b = body(r);
  assert.equal(b.data.valid, true);
  assert.equal(b.data.vat_number, "CHE-116.281.710 TVA");
  assert.equal(b.data.basis, "UID-WSE ValidateVatNumber");
  assert.equal(b.data.holder.name, "Muster & Söhne AG");
  assert.equal(actions.length, 2);
});

test("uid: SOAP fault in a 200 body becomes a graceful source error", async () => {
  const fault = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring xml:lang="de">Request_limit_exceeded</faultstring></s:Fault></s:Body></s:Envelope>`;
  const r = await withFetch(
    async () => new Response(fault, { status: 200 }),
    () => toolOf(uidModule, "search_uid_register").handler({ name: "Fault Test GmbH", limit: 5 }),
  );
  assert.equal(r.isError, true);
  const b = body(r);
  assert.match(b.error, /Request_limit_exceeded/);
  assert.match(b.suggestions[0], /20 requests/);
});

// ---------------------------------------------------------------------------
// Courts fixtures (Elasticsearch _search response shape)
// ---------------------------------------------------------------------------

const ES_SEARCH = {
  took: 12,
  timed_out: false,
  hits: {
    total: { value: 1234, relation: "eq" },
    max_score: 21.3,
    hits: [
      {
        _index: "entscheidsuche",
        _id: "CH_BGer_004_4A-123-2021_2021-09-01",
        _score: 21.345,
        _source: {
          id: "CH_BGer_004_4A-123-2021_2021-09-01",
          date: "2021-09-01",
          canton: "CH",
          hierarchy: ["CH", "CH_BGer", "CH_BGer_004"],
          title: { de: "Arbeitsvertrag; missbräuchliche Kündigung", fr: "Contrat de travail; résiliation abusive" },
          abstract: { de: "Missbräuchliche Kündigung nach Art. 336 OR; Entschädigung." },
          reference: ["4A_123/2021"],
          attachment: {
            content_url: "https://entscheidsuche.ch/docs/CH_BGer/CH_BGer_004_4A-123-2021_2021-09-01.html",
            content_type: "text/html",
          },
        },
        highlight: { "attachment.content": ["Die «Kündigung» war   missbräuchlich im Sinne von Art. 336 OR"] },
      },
      {
        _id: "ZH_OG_001_LA210012_2021-07-12",
        _score: 12.1,
        _source: {
          date: "2021-07-12T00:00:00Z",
          canton: "ZH",
          hierarchy: ["ZH", "ZH_OG"],
          title: "Forderung aus Arbeitsvertrag",
          reference: "LA210012-O",
          attachment: { content_url: "ZH_Obergericht/ZH_OG_001_LA210012_2021-07-12.pdf" },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Courts: pure helpers
// ---------------------------------------------------------------------------

test("courts: buildSearchQuery keeps user text as a JSON value and adds filters", () => {
  const evil = `x"}},"script":{"source":"boom`;
  const q = buildSearchQuery({ query: evil, court: "BGer", canton: "ch", date_from: "2020", date_to: "2021-02", language: "fr", sort: "date", limit: 5 });
  const roundTrip = JSON.parse(JSON.stringify(q));
  assert.equal(roundTrip.query.bool.must[0].simple_query_string.query, evil);
  assert.equal(roundTrip.script, undefined);
  assert.equal(q.size, 5);
  assert.ok(q.query.bool.must[0].simple_query_string.fields.includes("title.fr^4"));
  const [court, canton, range] = q.query.bool.filter;
  assert.deepEqual(court.bool.should[0], { terms: { hierarchy: ["CH_BGer"] } });
  assert.deepEqual(court.bool.should[1], { prefix: { id: "CH_BGer_" } });
  assert.deepEqual(canton.bool.should[0], { term: { canton: "CH" } });
  assert.deepEqual(range, { range: { date: { gte: "2020-01-01", lte: "2021-02-28" } } });
  assert.deepEqual(q.sort[0], { date: { order: "desc" } });
  assert.deepEqual(q._source, { excludes: ["attachment.content"] });
  const plain = buildSearchQuery({ query: "Miete", limit: 10 });
  assert.equal(plain.query.bool.filter, undefined);
  assert.equal(plain.sort, undefined);
});

test("courts: helpers: courtCodes, endOfPeriod, pickLang, resolveDocUrl, htmlToText", () => {
  assert.deepEqual(courtCodes("bvger"), ["CH_BVGer", "CH_BVGE"]);
  assert.deepEqual(courtCodes("ZH_OG"), ["ZH_OG"]);
  assert.equal(endOfPeriod("2024-02"), "2024-02-29");
  assert.equal(endOfPeriod("2020"), "2020-12-31");
  assert.equal(endOfPeriod("2020-05-06"), "2020-05-06");
  assert.equal(pickLang({ de: "D", fr: "F" }, "fr"), "F");
  assert.equal(pickLang({ it: "I" }, "fr"), "I");
  assert.equal(pickLang("S"), "S");
  assert.equal(pickLang(undefined), undefined);
  assert.equal(resolveDocUrl("ZH/x.pdf"), "https://entscheidsuche.ch/docs/ZH/x.pdf");
  assert.equal(resolveDocUrl("/docs/ZH/x.pdf"), "https://entscheidsuche.ch/docs/ZH/x.pdf");
  assert.equal(resolveDocUrl("https://www.bger.ch/x"), "https://www.bger.ch/x");
  assert.equal(
    htmlToText("<html><head><title>t</title></head><body><script>var x;</script><p>Erwägung&nbsp;1</p><p>A &amp; B&#8212;C</p></body></html>"),
    "Erwägung 1\nA & B\u2014C",
  );
  assert.equal(totalOf({ hits: { total: 7 } }), 7);
  assert.equal(totalOf(ES_SEARCH), 1234);
});

test("courts: normaliseHit maps federal and cantonal hits defensively", () => {
  const a = normaliseHit(ES_SEARCH.hits.hits[0], "de");
  assert.equal(a.reference, "4A_123/2021");
  assert.equal(a.court_code, "CH_BGer");
  assert.equal(a.court, "Federal Supreme Court (BGer)");
  assert.equal(a.format, "html");
  assert.deepEqual(a.highlights, ["Die «Kündigung» war missbräuchlich im Sinne von Art. 336 OR"]);
  const b = normaliseHit(ES_SEARCH.hits.hits[1], "fr");
  assert.equal(b.id, "ZH_OG_001_LA210012_2021-07-12");
  assert.equal(b.date, "2021-07-12");
  assert.equal(b.court, "ZH_OG");
  assert.equal(b.title, "Forderung aus Arbeitsvertrag");
  assert.equal(b.url, "https://entscheidsuche.ch/docs/ZH_Obergericht/ZH_OG_001_LA210012_2021-07-12.pdf");
  assert.equal(b.format, "pdf");
  assert.equal(b.abstract, undefined);
});

// ---------------------------------------------------------------------------
// Courts: handler paths
// ---------------------------------------------------------------------------

test("courts: search_court_decisions posts an ES body and returns decisions", async () => {
  let sent;
  const r = await withFetch(
    async (url, init) => {
      sent = { url, init };
      return new Response(JSON.stringify(ES_SEARCH), { status: 200 });
    },
    () =>
      toolOf(courtsModule, "search_court_decisions").handler({ query: "Kündigung Art. 336 OR", canton: "CH", sort: "relevance", limit: 10 }),
  );
  assert.equal(r.isError, undefined);
  assert.equal(sent.url, "https://entscheidsuche.ch/_search.php");
  assert.equal(sent.init.method, "POST");
  const q = JSON.parse(sent.init.body);
  assert.equal(q.query.bool.must[0].simple_query_string.query, "Kündigung Art. 336 OR");
  const b = body(r);
  assert.equal(b.data.total, 1234);
  assert.equal(b.data.decisions.length, 2);
  assert.equal(b.data.decisions[0].reference, "4A_123/2021");
});

test("courts: search surfaces ES errors and rejects unknown cantons", async () => {
  const r = await withFetch(
    async () => new Response(JSON.stringify({ error: { root_cause: [{ reason: "parse failure" }] }, status: 400 }), { status: 200 }),
    () => toolOf(courtsModule, "search_court_decisions").handler({ query: "error path", sort: "relevance", limit: 3 }),
  );
  assert.equal(r.isError, true);
  assert.match(body(r).error, /parse failure/);
  const bad = await toolOf(courtsModule, "search_court_decisions").handler({ query: "x y", canton: "XX", sort: "relevance", limit: 3 });
  assert.equal(bad.isError, true);
});

test("courts: get_court_decision falls back to the HTML page and truncates the excerpt", async () => {
  const hit = structuredClone(ES_SEARCH.hits.hits[0]);
  delete hit.highlight;
  const longText = "Sachverhalt. " + "Erwägung ".repeat(300);
  const urls = [];
  const r = await withFetch(
    async (url, init) => {
      urls.push(url);
      if (url.endsWith("_search.php")) {
        const q = JSON.parse(init.body);
        assert.deepEqual(q.query.bool.should[0], { ids: { values: ["CH_BGer_004_4A-123-2021_2021-09-01"] } });
        return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [hit] } }), { status: 200 });
      }
      return new Response(`<html><body><h1>4A_123/2021</h1><p>${longText}</p></body></html>`, { status: 200 });
    },
    () => toolOf(courtsModule, "get_court_decision").handler({ id: "CH_BGer_004_4A-123-2021_2021-09-01", max_chars: 500 }),
  );
  assert.equal(r.isError, undefined);
  assert.deepEqual(urls, [
    "https://entscheidsuche.ch/_search.php",
    "https://entscheidsuche.ch/docs/CH_BGer/CH_BGer_004_4A-123-2021_2021-09-01.html",
  ]);
  const b = body(r);
  assert.equal(b.data.reference, "4A_123/2021");
  assert.equal(b.data.text_source, "html");
  assert.equal(b.data.truncated, true);
  assert.ok(b.data.text_excerpt.startsWith("4A_123/2021\nSachverhalt."));
  assert.equal(b.data.text_excerpt.length, 501);
  assert.equal(b.links.document, "https://entscheidsuche.ch/docs/CH_BGer/CH_BGer_004_4A-123-2021_2021-09-01.html");
});

test("courts: get_court_decision uses indexed content when present and reports not-found", async () => {
  const hit = structuredClone(ES_SEARCH.hits.hits[1]);
  hit._source.attachment.content = "Urteil vom 12. Juli 2021.\n\n\n\nDispositiv: Die Berufung wird abgewiesen.";
  const r = await withFetch(
    async () => new Response(JSON.stringify({ hits: { hits: [hit] } }), { status: 200 }),
    () => toolOf(courtsModule, "get_court_decision").handler({ id: "ZH_OG_001_LA210012_2021-07-12", max_chars: 20000 }),
  );
  const b = body(r);
  assert.equal(b.data.text_source, "index");
  assert.equal(b.data.truncated, false);
  assert.equal(b.data.text_excerpt, "Urteil vom 12. Juli 2021.\n\nDispositiv: Die Berufung wird abgewiesen.");
  const nf = await withFetch(
    async () => new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 }),
    () => toolOf(courtsModule, "get_court_decision").handler({ id: "does-not-exist", max_chars: 1000 }),
  );
  assert.equal(nf.isError, true);
});

test("compliance: tool names are unique and not colliding with reserved names", () => {
  const names = [...uidModule.tools, ...courtsModule.tools].map((t) => t.name);
  assert.deepEqual(names, ["lookup_uid", "search_uid_register", "validate_vat_number", "search_court_decisions", "get_court_decision"]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(uidModule.healthProbes.length && courtsModule.healthProbes.length);
});
