/**
 * UID module: the federal UID register (Unternehmens-Identifikationsnummer,
 * operated by the Federal Statistical Office FSO/BFS) via its public SOAP
 * web service "UID-WSE" (PublicServices, V5.0).
 *
 * Why this exists next to ZEFIX: the UID register covers EVERY entity that
 * has a UID: associations and foundations not in the commercial register,
 * sole proprietors, public administrations, VAT-only registrations, and it
 * carries the VAT register status, which ZEFIX does not.
 *
 * No SOAP/XML dependency: envelopes are built from strings with strict XML
 * escaping, and responses are parsed by a small namespace-agnostic XML
 * tokenizer (`parseXml`) plus descendant lookups by local tag name.
 */

import { z } from "zod";
import { allowHosts, fetchCached, SourceError, sourceCache } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

allowHosts("www.uid-wse.admin.ch");

const uidRegister: SourceManifest = {
  id: "uid-register",
  name: "UID Register: Swiss business identification number register",
  operator: "Federal Statistical Office (FSO/BFS)",
  url: "https://www.uid.admin.ch",
  licence: "Public UID register data (UIDG Art. 11); free use with source attribution",
  attribution: "© Federal Statistical Office (FSO), UID register",
  updateFrequency: "daily (register mutations)",
  cacheTtlSeconds: 24 * 3600,
  notes:
    "Public UID-WSE access is rate-limited by the FSO to about 20 requests per minute per client; Swissyphus caches every " +
    "answer for 24 h. High confidence: endpoint, SOAP 1.1 namespace/SOAPAction form, operation names, the UID check-digit " +
    "algorithm, and the core fields organisationName/legalForm/address/uid. Medium confidence: the eCH-0097/5 and " +
    "uid-wse-shared/2 namespaces used inside the request body, and the vatRegisterInformation/commercialRegisterInformation " +
    "field names. Low confidence: the human labels attached to numeric status codes (raw codes are always returned too). " +
    "Canton/postcode filters on search are applied client-side to the returned candidates. SOAP faults (e.g. rate limit " +
    "exceeded) surface as HTTP 500 without detail.",
};

const ENDPOINT = "https://www.uid-wse.admin.ch/V5.0/PublicServices.svc";
const NS_UID_WSE = "http://www.uid.admin.ch/xmlns/uid-wse";
const NS_ECH_0097 = "http://www.ech.ch/xmlns/eCH-0097/5";
const NS_SHARED = "http://www.uid.admin.ch/xmlns/uid-wse-shared/2";

// ---------------------------------------------------------------------------
// UID normalisation + check digit
// ---------------------------------------------------------------------------

const UID_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4];

/**
 * Compute the UID check digit (9th digit) from the first 8 digits: weighted
 * sum with weights 5,4,3,2,7,6,5,4, mod 11; check = 11 - rem (11 → 0).
 * Returns null if the result would be 10 (such numbers are never issued).
 */
export function uidCheckDigit(first8: string): number | null {
  if (!/^\d{8}$/.test(first8)) return null;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(first8[i]) * UID_WEIGHTS[i];
  const check = 11 - (sum % 11);
  if (check === 11) return 0;
  if (check === 10) return null;
  return check;
}

export interface NormalisedUid {
  category: "CHE" | "ADM";
  digits: string;
  formatted: string;
  valid: boolean;
  vatSuffix?: "MWST" | "TVA" | "IVA";
  error?: string;
}

/**
 * Normalise a UID written in any common form: "CHE-123.456.789",
 * "CHE123456789", "che 123 456 789", "123456789", "CHE-123.456.789 MWST".
 * Returns null if it cannot be read as a UID at all; otherwise `valid`
 * reflects the check digit.
 */
export function normaliseUid(input: string): NormalisedUid | null {
  const raw = input.trim().toUpperCase();
  const suffixMatch = raw.match(/(MWST|TVA|IVA|VAT)\.?\s*$/);
  const vatSuffix = suffixMatch
    ? ((suffixMatch[1] === "VAT" ? "MWST" : suffixMatch[1]) as "MWST" | "TVA" | "IVA")
    : undefined;
  const body = suffixMatch ? raw.slice(0, suffixMatch.index).trim() : raw;
  const m = body.match(/^(CHE|ADM)?[\s\-.:]*((?:\d[\s\-.]*){9})$/);
  if (!m) return null;
  const category = (m[1] ?? "CHE") as "CHE" | "ADM";
  const digits = m[2].replace(/\D/g, "");
  if (digits.length !== 9) return null;
  const formatted = `${category}-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  const expected = uidCheckDigit(digits.slice(0, 8));
  const valid = expected !== null && expected === Number(digits[8]);
  return {
    category,
    digits,
    formatted,
    valid,
    ...(vatSuffix ? { vatSuffix } : {}),
    ...(valid
      ? {}
      : {
          error:
            expected === null
              ? "The first 8 digits produce check value 10, which is never issued."
              : `Check digit mismatch: expected ${expected}, got ${digits[8]}.`,
        }),
  };
}

// ---------------------------------------------------------------------------
// XML: escaping + a small namespace-agnostic parser
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s
    // Drop characters that are illegal in XML 1.0 regardless of escaping.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface XmlNode {
  /** Local name (namespace prefix stripped). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content (entities decoded, trimmed). */
  text: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

/**
 * Parse XML into a light tree. Namespace prefixes are stripped from element
 * and attribute names, comments/PIs/doctype are skipped, CDATA is kept as
 * text. Tolerant: stray close tags are ignored and unclosed elements are
 * closed at end of input. Returns a synthetic "#document" root.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const textParts: string[][] = [[]];
  let i = 0;
  const n = xml.length;

  const closeTop = () => {
    const node = stack.pop()!;
    node.text = textParts.pop()!.join("").trim();
  };

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      textParts[textParts.length - 1].push(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) textParts[textParts.length - 1].push(decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      textParts[textParts.length - 1].push(xml.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    // Find the end of the tag, respecting quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    const inner = xml.slice(lt + 1, j);
    i = j + 1;

    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim());
      // Close up to the matching open element; ignore stray close tags.
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k > 0) while (stack.length > k) closeTop();
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^\s*([^\s/>]+)/);
    if (!nameMatch) continue;
    const node: XmlNode = { name: localName(nameMatch[1]), attrs: {}, children: [], text: "" };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    const attrSrc = body.slice(nameMatch[0].length);
    while ((am = attrRe.exec(attrSrc))) {
      const an = am[1];
      if (an === "xmlns" || an.startsWith("xmlns:")) continue;
      node.attrs[localName(an)] = decodeEntities(am[3] ?? am[4] ?? "");
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
      textParts.push([]);
    }
  }
  while (stack.length > 1) closeTop();
  root.text = textParts[0].join("").trim();
  return root;
}

/** First descendant (depth-first, excluding `node` itself) with this local name. */
export function findFirst(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const d = findFirst(c, name);
    if (d) return d;
  }
  return undefined;
}

/** All descendants with this local name (does not descend into matches). */
export function findAll(node: XmlNode | undefined, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      else walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** Text of the first descendant with this local name; undefined for missing/nil/empty. */
export function textOf(node: XmlNode | undefined, name: string): string | undefined {
  const f = findFirst(node, name);
  if (!f || f.attrs["nil"] === "true") return undefined;
  return f.text || undefined;
}

// ---------------------------------------------------------------------------
// SOAP plumbing
// ---------------------------------------------------------------------------

export function buildEnvelope(operation: string, bodyXml: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:uid="${NS_UID_WSE}" xmlns:ech0097="${NS_ECH_0097}" xmlns:shared="${NS_SHARED}">` +
    `<soapenv:Header/><soapenv:Body><uid:${operation}>${bodyXml}</uid:${operation}></soapenv:Body></soapenv:Envelope>`
  );
}

export function getByUidEnvelope(u: NormalisedUid): string {
  return buildEnvelope(
    "GetByUID",
    `<uid:uid><ech0097:uidOrganisationIdCategorie>${xmlEscape(u.category)}</ech0097:uidOrganisationIdCategorie>` +
      `<ech0097:uidOrganisationId>${xmlEscape(u.digits)}</ech0097:uidOrganisationId></uid:uid>`,
  );
}

export function searchEnvelope(name: string): string {
  return buildEnvelope(
    "Search",
    `<uid:searchParameters><shared:organisationName>${xmlEscape(name)}</shared:organisationName></uid:searchParameters>`,
  );
}

export function validateVatEnvelope(vatNumber: string): string {
  return buildEnvelope("ValidateVatNumber", `<uid:vatNumber>${xmlEscape(vatNumber)}</uid:vatNumber>`);
}

async function soapCall(operation: string, envelope: string) {
  const res = await fetchCached(ENDPOINT, {
    ...sourceCache(uidRegister),
    timeoutMs: 20_000,
    maxBytes: 2 * 1024 * 1024,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${NS_UID_WSE}/IPublicServices/${operation}"`,
        Accept: "text/xml",
      },
      body: envelope,
    },
  });
  const doc = parseXml(res.data);
  const fault = findFirst(doc, "Fault");
  if (fault) {
    const msg = textOf(fault, "faultstring") ?? textOf(fault, "Text") ?? "SOAP fault";
    throw new SourceError(`UID-WSE returned a SOAP fault: ${msg}`, "www.uid-wse.admin.ch");
  }
  if (!findFirst(doc, "Body")) {
    throw new SourceError("UID-WSE returned a non-SOAP response (possibly down or changed format).", "www.uid-wse.admin.ch");
  }
  return { doc, cacheStatus: res.cacheStatus, retrievedAt: res.retrievedAt };
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/** eCH-0097 legal-form codes (best-effort English labels; raw code always returned). */
export const UID_LEGAL_FORMS: Record<string, string> = {
  "0101": "Sole proprietorship",
  "0103": "General partnership",
  "0104": "Limited partnership",
  "0105": "Company limited by shares (AG/SA)",
  "0106": "Partnership limited by shares",
  "0107": "Limited liability company (GmbH/Sàrl)",
  "0108": "Cooperative",
  "0109": "Association",
  "0110": "Foundation",
  "0111": "Branch of a foreign company (registered)",
  "0113": "Special legal form",
  "0114": "Limited partnership for collective investment",
  "0115": "Investment company with variable capital (SICAV)",
  "0116": "Investment company with fixed capital (SICAF)",
  "0117": "Institute of public law",
  "0118": "Non-commercial power of attorney",
  "0151": "Swiss branch (registered)",
  "0220": "Federal administration",
  "0221": "Cantonal administration",
  "0222": "District administration",
  "0223": "Municipal administration",
  "0224": "Public-law corporation (administration)",
  "0230": "Federal enterprise",
  "0231": "Cantonal enterprise",
  "0232": "District enterprise",
  "0233": "Municipal enterprise",
  "0234": "Public-law corporation (enterprise)",
  "0302": "Simple partnership",
  "0312": "Branch of a foreign company (not registered)",
  "0327": "Foreign public enterprise",
  "0328": "Foreign public administration",
  "0329": "International organisation",
  "0441": "Foreign enterprise",
};

/** Low-confidence labels for commercialRegisterStatus codes. */
const CR_STATUS: Record<string, string> = { "1": "unknown", "2": "registered", "3": "deleted" };
/** Low-confidence labels for vatStatus codes. */
const VAT_STATUS: Record<string, string> = { "1": "pending", "2": "active", "3": "deleted" };

function formatUidFromNode(node: XmlNode | undefined): string | undefined {
  const cat = textOf(node, "uidOrganisationIdCategorie");
  const id = textOf(node, "uidOrganisationId");
  if (!cat || !id) return undefined;
  const d = id.padStart(9, "0");
  return `${cat}-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
}

export interface UidRecord {
  uid?: string;
  name?: string;
  legal_name?: string;
  additional_name?: string;
  legal_form_code?: string;
  legal_form?: string;
  address?: {
    street?: string;
    house_number?: string;
    address_line?: string;
    postcode?: string;
    town?: string;
    municipality?: string;
    municipality_bfs_id?: string;
    canton?: string;
    country?: string;
  };
  uid_register?: {
    status_code?: string;
    public_status?: string;
    organisation_type_code?: string;
    liquidation_date?: string;
    replaced_by_uid?: string;
  };
  vat?: {
    registered: boolean;
    vat_number?: string;
    status_code?: string;
    status?: string;
    entry_status_code?: string;
    entry_date?: string;
    liquidation_date?: string;
  };
  commercial_register?: {
    status_code?: string;
    status?: string;
    entry_status_code?: string;
    entry_date?: string;
    liquidation_date?: string;
  };
  match_rating?: number;
}

/** Map one UID-WSE organisation record (any wrapper element) to a compact record. */
export function mapOrganisation(rec: XmlNode): UidRecord {
  const ident = findFirst(rec, "organisationIdentification") ?? rec;
  const uidNode = findFirst(ident, "uid");
  const legalForm = textOf(ident, "legalForm");
  const addr = findFirst(rec, "address");
  const uidreg = findFirst(rec, "uidregInformation");
  const vatNode = findFirst(rec, "vatRegisterInformation");
  const crNode = findFirst(rec, "commercialRegisterInformation");
  const rating = textOf(rec, "rating");

  const vatUid = formatUidFromNode(findFirst(vatNode, "uidVat"));
  const vatStatus = textOf(vatNode, "vatStatus");
  const vatLiq = textOf(vatNode, "vatLiquidationDate");
  const crStatus = textOf(crNode, "commercialRegisterStatus");

  const out: UidRecord = {
    uid: formatUidFromNode(uidNode),
    name: textOf(ident, "organisationName"),
    legal_name: textOf(ident, "organisationLegalName"),
    additional_name: textOf(ident, "organisationAdditionalName"),
    legal_form_code: legalForm,
    legal_form: legalForm ? (UID_LEGAL_FORMS[legalForm] ?? `code ${legalForm}`) : undefined,
  };
  if (addr) {
    out.address = {
      street: textOf(addr, "street"),
      house_number: textOf(addr, "houseNumber"),
      address_line: textOf(addr, "addressLine1"),
      postcode: textOf(addr, "swissZipCode") ?? textOf(addr, "foreignZipCode"),
      town: textOf(addr, "town"),
      municipality: textOf(addr, "municipalityName") ?? textOf(rec, "municipalityName"),
      municipality_bfs_id: textOf(addr, "municipalityId") ?? textOf(rec, "municipalityId"),
      canton: textOf(addr, "cantonAbbreviation") ?? textOf(rec, "cantonAbbreviation"),
      country: textOf(addr, "countryIdISO2"),
    };
  }
  if (uidreg) {
    out.uid_register = {
      status_code: textOf(uidreg, "uidregStatusEnterpriseDetail"),
      public_status: textOf(uidreg, "uidregPublicStatus"),
      organisation_type_code: textOf(uidreg, "uidregOrganisationType"),
      liquidation_date: textOf(uidreg, "uidregLiquidationDate"),
      replaced_by_uid: formatUidFromNode(findFirst(uidreg, "uidReplacement")),
    };
  }
  if (vatNode) {
    out.vat = {
      // Registered = there is a VAT record, it is not flagged deleted and has no liquidation date.
      registered: Boolean(vatStatus) && vatStatus !== "3" && !vatLiq,
      vat_number: vatUid ? `${vatUid} MWST` : undefined,
      status_code: vatStatus,
      status: vatStatus ? VAT_STATUS[vatStatus] : undefined,
      entry_status_code: textOf(vatNode, "vatEntryStatus"),
      entry_date: textOf(vatNode, "vatEntryDate"),
      liquidation_date: vatLiq,
    };
  } else {
    out.vat = { registered: false };
  }
  if (crNode) {
    out.commercial_register = {
      status_code: crStatus,
      status: crStatus ? CR_STATUS[crStatus] : undefined,
      entry_status_code: textOf(crNode, "commercialRegisterEntryStatus"),
      entry_date: textOf(crNode, "commercialRegisterEntryDate"),
      liquidation_date: textOf(crNode, "commercialRegisterLiquidationDate"),
    };
  }
  if (rating && !Number.isNaN(Number(rating))) out.match_rating = Number(rating);
  return prune(out) as UidRecord;
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val);
      if (p === undefined) continue;
      if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      o[k] = p;
    }
    return o;
  }
  return v;
}

/**
 * Extract organisation records from a GetByUID / Search SOAP response. Each
 * direct child of the `<XxxResult>` element is one record (the wrapper name
 * differs between operations and versions, so it is not relied upon).
 */
export function extractRecords(doc: XmlNode): UidRecord[] {
  const body = findFirst(doc, "Body");
  const response = body?.children[0];
  const result = response?.children.find((c) => c.name.endsWith("Result")) ?? response;
  if (!result) return [];
  // A record is the outermost element containing exactly one
  // organisationIdentification; wrappers holding several are descended into.
  const records: XmlNode[] = [];
  const collect = (node: XmlNode) => {
    for (const c of node.children) {
      const count = findAll(c, "organisationIdentification").length + (c.name === "organisationIdentification" ? 1 : 0);
      if (count === 1) records.push(c);
      else if (count > 1) collect(c);
    }
  };
  collect(result);
  return records.map(mapOrganisation);
}

/** Read the boolean result of a ValidateXxx operation. */
export function extractBoolean(doc: XmlNode, operation: string): boolean | undefined {
  const t = textOf(doc, `${operation}Result`)?.toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const RATE_LIMIT_HINT = "The public UID-WSE allows ~20 requests/minute; wait a minute and retry.";

function invalidUidError(input: string, n: NormalisedUid | null) {
  if (!n) {
    return toolError(`'${input}' is not a UID. Expected e.g. 'CHE-123.456.789' (9 digits, optional CHE prefix).`, [
      "Swiss UIDs have the form CHE-123.456.789; a VAT number is the UID plus 'MWST', 'TVA' or 'IVA'.",
      "To find a UID by name use search_uid_register or search_companies.",
    ]);
  }
  return toolError(`'${n.formatted}' is not a valid UID: ${n.error}`, [
    "Check for a typo; the last digit is a mod-11 check digit.",
    "Use search_uid_register to find the correct UID by name.",
  ]);
}

export const uidModule: SwissyphusModule = {
  id: "uid",
  emoji: "🆔",
  title: "UID register (BFS)",
  description:
    "Look up any Swiss UID (companies, associations, foundations, sole proprietors, public bodies), search by name, and verify VAT registration",
  sources: [uidRegister],
  healthProbes: [{ sourceId: "uid-register", url: `${ENDPOINT}?wsdl` }],
  tools: [
    tool({
      name: "lookup_uid",
      title: "Look up a Swiss UID",
      description:
        "Look up one entity in the federal UID register (BFS) by its UID, e.g. 'CHE-107.028.276', 'CHE107028276', '107028276' or a VAT number 'CHE-107.028.276 MWST'. " +
        "Validates the check digit first (offline). Returns name, legal form, address, UID status, VAT register status (registered yes/no, VAT number, entry date) " +
        "and commercial-register status. Covers ALL UID holders incl. associations, foundations, sole proprietors and public bodies that are not in ZEFIX.",
      inputSchema: {
        uid: z.string().min(9).max(40).describe("UID in any format, e.g. 'CHE-107.028.276' or '107028276'"),
      },
      handler: async ({ uid }) => {
        const n = normaliseUid(uid);
        if (!n || !n.valid) return invalidUidError(uid, n);
        try {
          const { doc, cacheStatus, retrievedAt } = await soapCall("GetByUID", getByUidEnvelope(n));
          const records = extractRecords(doc);
          if (!records.length) {
            return toolError(`UID ${n.formatted} has a valid check digit but is not in the UID register.`, [
              "It may never have been issued, or it may be withheld from public view.",
              "Try search_uid_register with the entity's name.",
            ]);
          }
          return respond(
            { query_uid: n.formatted, check_digit_valid: true, entity: records[0], ...(records.length > 1 ? { additional: records.slice(1, 5) } : {}) },
            {
              source: uidRegister,
              cacheStatus,
              retrievedAt,
              links: { uid_register: `https://www.uid.admin.ch/Detail.aspx?uid_id=${n.category}${n.digits}` },
            },
          );
        } catch (err) {
          const r = errorToResult(err, "UID register (UID-WSE)");
          return withHint(r);
        }
      },
    }),

    tool({
      name: "search_uid_register",
      title: "Search the UID register by name",
      description:
        "Search the federal UID register (BFS) by entity name; it covers every UID holder (companies, associations, foundations, sole proprietors, public administrations), " +
        "not just commercial-register entries. Optionally narrow by canton ('ZH') or postcode ('8001'); these filters are applied to the returned candidates. " +
        "Returns UID, name, legal form, address, VAT and commercial-register status. Example: name='Pro Natura', name='Gemeinde Köniz'.",
      inputSchema: {
        name: z.string().min(2).max(200).describe("Entity name or fragment, e.g. 'Migros', 'Verein Pro Velo'"),
        canton: z.string().length(2).optional().describe("Optional canton filter, e.g. 'BE'"),
        postcode: z.string().regex(/^\d{4}$/).optional().describe("Optional Swiss postcode filter, e.g. '3001'"),
        limit: z.number().int().min(1).max(25).default(10),
      },
      handler: async ({ name, canton, postcode, limit }) => {
        try {
          const { doc, cacheStatus, retrievedAt } = await soapCall("Search", searchEnvelope(name.trim()));
          const all = extractRecords(doc);
          const cantonUp = canton?.toUpperCase();
          // Records without canton data are kept (not every record carries a canton);
          // records with a different known canton / postcode are dropped.
          const filtered = all.filter(
            (r) =>
              (!cantonUp || !r.address?.canton || r.address.canton.toUpperCase() === cantonUp) &&
              (!postcode || r.address?.postcode === postcode),
          );
          const cantonUnverified = Boolean(cantonUp) && filtered.some((r) => !r.address?.canton);
          if (!filtered.length) {
            return toolError(
              all.length
                ? `The UID register returned ${all.length} match(es) for '${name}', but none in ${[cantonUp, postcode].filter(Boolean).join(" / ")}.`
                : `No UID register entries found for '${name}'.`,
              [
                "Try a shorter or alternative name fragment (legal name, other language).",
                ...(all.length ? ["Drop the canton/postcode filter (canton data is not present on every record)."] : []),
                "For commercial-register companies, search_companies (ZEFIX) is an alternative.",
              ],
            );
          }
          return respond(
            { total_returned: all.length, results: filtered.slice(0, limit) },
            {
              source: uidRegister,
              cacheStatus,
              retrievedAt,
              ...(cantonUnverified
                ? { notes: "Some records carry no canton; they were kept. Check address.postcode/town to confirm the canton." }
                : {}),
            },
          );
        } catch (err) {
          return withHint(errorToResult(err, "UID register (UID-WSE)"));
        }
      },
    }),

    tool({
      name: "validate_vat_number",
      title: "Validate a Swiss VAT number",
      description:
        "Check whether a Swiss VAT number (MWST/TVA/IVA) is valid and active in the federal VAT register via the UID register, e.g. 'CHE-107.028.276 MWST', 'CHE107028276TVA' or '107028276'. " +
        "Returns valid true/false, the normalised VAT number and (with include_details) the holder's name, address and VAT entry date; use it for supplier/invoice checks.",
      inputSchema: {
        vat_number: z.string().min(9).max(40).describe("Swiss VAT number, e.g. 'CHE-107.028.276 MWST'"),
        include_details: z.boolean().default(true).describe("Also fetch the holder's name/address/VAT dates (one extra request)"),
      },
      handler: async ({ vat_number, include_details }) => {
        const n = normaliseUid(vat_number);
        if (!n || !n.valid) return invalidUidError(vat_number, n);
        const suffix = n.vatSuffix ?? "MWST";
        let valid: boolean | undefined;
        let cacheStatus: "hit" | "miss" | "stale" | "computed" = "computed";
        let retrievedAt = new Date().toISOString();
        let validateError: string | undefined;
        try {
          const r = await soapCall("ValidateVatNumber", validateVatEnvelope(n.formatted));
          valid = extractBoolean(r.doc, "ValidateVatNumber");
          cacheStatus = r.cacheStatus;
          retrievedAt = r.retrievedAt;
        } catch (err) {
          validateError = err instanceof Error ? err.message : String(err);
        }
        let holder: UidRecord | undefined;
        if (include_details || valid === undefined) {
          try {
            const r = await soapCall("GetByUID", getByUidEnvelope(n));
            holder = extractRecords(r.doc)[0];
            if (cacheStatus === "computed") {
              cacheStatus = r.cacheStatus;
              retrievedAt = r.retrievedAt;
            }
          } catch (err) {
            if (valid === undefined) return withHint(errorToResult(err, "UID register (UID-WSE)"));
          }
        }
        const derivedFromRecord = valid === undefined;
        if (derivedFromRecord) valid = holder ? Boolean(holder.vat?.registered) : false;
        return respond(
          {
            vat_number: `${n.formatted} ${suffix}`,
            valid,
            basis: derivedFromRecord
              ? "derived from the UID record's vatRegisterInformation (ValidateVatNumber was unavailable)"
              : "UID-WSE ValidateVatNumber",
            ...(validateError ? { validate_error: validateError } : {}),
            ...(holder
              ? { holder: { uid: holder.uid, name: holder.name, legal_form: holder.legal_form, address: holder.address, vat: holder.vat } }
              : {}),
          },
          { source: uidRegister, cacheStatus, retrievedAt },
        );
      },
    }),
  ],
};

function withHint(r: ReturnType<typeof toolError>) {
  try {
    const block = r.content[0];
    if (block?.type === "text") {
      const body = JSON.parse(block.text) as { suggestions?: string[] };
      body.suggestions = [RATE_LIMIT_HINT, ...(body.suggestions ?? [])];
      block.text = JSON.stringify(body, null, 2);
    }
  } catch {
    /* leave as-is */
  }
  return r;
}
