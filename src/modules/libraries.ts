/**
 * Libraries module: swisscovery, the union catalogue of ~490 Swiss academic
 * and research libraries (SLSP), incl. the Swiss National Library's partners,
 * ETH and the cantonal/university libraries: books, journals, theses,
 * archival holdings, maps, e-resources.
 *
 * Public SRU endpoint (no key):
 *   https://swisscovery.slsp.ch/view/sru/41SLSP_NETWORK?version=1.2&operation=searchRetrieve
 *     &recordSchema=marcxml&query=<CQL>&maximumRecords=&startRecord=
 * CQL indexes used: alma.all_for_ui, alma.title, alma.creator, alma.subjects, alma.isbn.
 */

import { z } from "zod";
import { allowHosts, fetchTextCached } from "../core/http.js";
import { respond, errorToResult, toolError } from "../core/envelope.js";
import { tool, type SwissyphusModule } from "../core/module.js";
import type { SourceManifest } from "../core/types.js";

allowHosts("swisscovery.slsp.ch");

const slsp: SourceManifest = {
  id: "swisscovery",
  name: "swisscovery: Swiss academic library union catalogue (SLSP)",
  operator: "Swiss Library Service Platform AG (SLSP)",
  url: "https://swisscovery.slsp.ch",
  licence: "Bibliographic metadata from the SLSP network zone; reuse subject to SLSP terms (licence not confirmed for hosted redistribution), cite swisscovery",
  attribution: "Source: swisscovery / SLSP",
  updateFrequency: "continuous",
  cacheTtlSeconds: 6 * 3600,
  notes: "Public SRU 1.2 interface returning MARC21-XML; Swissyphus extracts title, creators, publication, ISBN, subjects and online links.",
};

const SRU = "https://swisscovery.slsp.ch/view/sru/41SLSP_NETWORK";

const INDEX: Record<string, string> = {
  any: "alma.all_for_ui",
  title: "alma.title",
  author: "alma.creator",
  subject: "alma.subjects",
  isbn: "alma.isbn",
};

/** Build a CQL query; user text is stripped of quotes and CQL operators' syntax characters. */
export function buildCql(terms: Partial<Record<keyof typeof INDEX, string>>): string | undefined {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(terms)) {
    if (!v) continue;
    const clean = v.replace(/["\\()<>=/]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    parts.push(k === "isbn" ? `${INDEX[k]}=${clean.replace(/[^0-9Xx]/g, "")}` : `${INDEX[k]}="${clean}"`);
  }
  return parts.length ? parts.join(" AND ") : undefined;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const dec = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m),
  );

interface Field {
  tag: string;
  sub: Array<[string, string]>;
}

function parseRecord(xml: string): { control: Map<string, string>; fields: Field[] } {
  const control = new Map<string, string>();
  for (const m of xml.matchAll(/<controlfield tag="(\d{3})">([^<]*)<\/controlfield>/g)) control.set(m[1]!, dec(m[2]!));
  const fields: Field[] = [];
  for (const m of xml.matchAll(/<datafield[^>]*tag="(\d{3})"[^>]*>([\s\S]*?)<\/datafield>/g)) {
    const sub: Array<[string, string]> = [];
    for (const s of m[2]!.matchAll(/<subfield code="([^"]+)">([\s\S]*?)<\/subfield>/g)) sub.push([s[1]!, dec(s[2]!).trim()]);
    fields.push({ tag: m[1]!, sub });
  }
  return { control, fields };
}

const trimPunct = (s: string) => s.replace(/\s*[/:;,.=]+\s*$/, "").trim();
const first = (fs: Field[], tag: string, code: string) => fs.find((f) => f.tag === tag)?.sub.find(([c]) => c === code)?.[1];
const all = (fs: Field[], tag: string, code: string) => fs.filter((f) => f.tag === tag).flatMap((f) => f.sub.filter(([c]) => c === code).map(([, v]) => v));

export function mapMarc(xml: string) {
  const { control, fields } = parseRecord(xml);
  const id = control.get("001");
  const f008 = control.get("008") ?? "";
  const title = [first(fields, "245", "a"), first(fields, "245", "b")].filter(Boolean).map((s) => trimPunct(s!)).join(": ");
  const creators = [...all(fields, "100", "a"), ...all(fields, "110", "a"), ...all(fields, "700", "a"), ...all(fields, "710", "a")].map(trimPunct);
  const pub = fields.find((f) => f.tag === "264" || f.tag === "260");
  const pubGet = (c: string) => pub?.sub.filter(([k]) => k === c).map(([, v]) => trimPunct(v));
  const year = /^\d{4}$/.test(f008.slice(7, 11)) ? f008.slice(7, 11) : pubGet("c")?.[0]?.match(/\d{4}/)?.[0];
  const lang = f008.slice(35, 38).trim();
  return {
    id,
    title: title || undefined,
    ...(creators.length ? { creators: [...new Set(creators)].slice(0, 6) } : {}),
    ...(first(fields, "250", "a") ? { edition: trimPunct(first(fields, "250", "a")!) } : {}),
    ...(pubGet("b")?.length ? { publisher: pubGet("b")!.join("; ") } : {}),
    ...(pubGet("a")?.length ? { place: pubGet("a")!.join("; ") } : {}),
    ...(year ? { year } : {}),
    ...(lang && /^[a-z]{3}$/.test(lang) ? { language: lang } : {}),
    ...(first(fields, "300", "a") ? { extent: trimPunct(first(fields, "300", "a")!) } : {}),
    ...(all(fields, "020", "a").length ? { isbn: [...new Set(all(fields, "020", "a").map((s) => s.split(" ")[0]!))].slice(0, 3) } : {}),
    ...(all(fields, "650", "a").length ? { subjects: [...new Set(all(fields, "650", "a").map(trimPunct))].slice(0, 8) } : {}),
    ...(all(fields, "490", "a").length ? { series: trimPunct(all(fields, "490", "a")[0]!) } : {}),
    ...(all(fields, "856", "u").length ? { online: all(fields, "856", "u").slice(0, 3) } : {}),
    ...(id ? { url: `https://swisscovery.slsp.ch/discovery/fulldisplay?docid=alma${id}&vid=41SLSP_NETWORK:VU1_UNION` } : {}),
  };
}

export function parseSru(xml: string): { total: number; records: Array<ReturnType<typeof mapMarc>>; diagnostic?: string } {
  const total = Number(xml.match(/<numberOfRecords>(\d+)<\/numberOfRecords>/)?.[1] ?? 0);
  const diagnostic = xml.match(/<diag:message>([^<]*)<\/diag:message>/)?.[1];
  const records = [...xml.matchAll(/<record xmlns="http:\/\/www\.loc\.gov\/MARC21\/slim">([\s\S]*?)<\/record>/g)].map((m) => mapMarc(m[1]!));
  return { total, records, ...(diagnostic ? { diagnostic: dec(diagnostic) } : {}) };
}

export const librariesModule: SwissyphusModule = {
  id: "libraries",
  emoji: "📚",
  title: "Library catalogue (swisscovery)",
  description:
    "Search swisscovery, the union catalogue of ~490 Swiss academic and research libraries (ETH, universities, cantonal libraries, archives): books, journals, theses, maps and e-resources with ISBN, subjects and online links",
  sources: [slsp],
  healthProbes: [
    { sourceId: "swisscovery", url: `${SRU}?version=1.2&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1&query=alma.isbn=9783036951522` },
  ],
  tools: [
    tool({
      name: "search_library_catalogue",
      title: "Search Swiss academic libraries (swisscovery)",
      description:
        "Search the swisscovery union catalogue of Swiss academic libraries by keywords, title, author, subject or ISBN (fields are combined with AND). " +
        "Returns bibliographic records (title, creators, publisher, year, ISBN, subjects, online links) and a swisscovery link to check holdings/availability. " +
        "Example: {author: 'Spyri', title: 'Heidi'}, {subject: 'Gletscher', keywords: 'Klimawandel'}.",
      inputSchema: {
        keywords: z.string().min(2).max(200).optional().describe("Free-text keywords (all fields)"),
        title: z.string().min(2).max(200).optional(),
        author: z.string().min(2).max(120).optional(),
        subject: z.string().min(2).max(120).optional(),
        isbn: z.string().regex(/^[0-9Xx -]{10,17}$/).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).max(9950).default(0),
      },
      handler: async ({ keywords, title, author, subject, isbn, limit, offset }) => {
        const cql = buildCql({ any: keywords, title, author, subject, isbn });
        if (!cql) return toolError("Give at least one of keywords, title, author, subject or isbn.");
        const qs = new URLSearchParams({
          version: "1.2",
          operation: "searchRetrieve",
          recordSchema: "marcxml",
          query: cql,
          maximumRecords: String(limit),
          startRecord: String(offset + 1),
        });
        try {
          const { data, cacheStatus, retrievedAt } = await fetchTextCached(`${SRU}?${qs}`, { ttlMs: slsp.cacheTtlSeconds * 1000, timeoutMs: 25_000 });
          const r = parseSru(data);
          if (r.diagnostic) return toolError(`swisscovery rejected the query: ${r.diagnostic}`, ["Simplify the search terms."]);
          if (!r.records.length) return toolError("No catalogue records found.", ["Use fewer or broader terms; try the original-language title."]);
          return respond(
            {
              total: r.total,
              offset,
              records: r.records,
              ...(r.total > offset + r.records.length ? { next_offset: offset + r.records.length } : {}),
            },
            { source: slsp, cacheStatus, retrievedAt },
          );
        } catch (err) {
          return errorToResult(err, "swisscovery");
        }
      },
    }),
  ],
};
