// research.ts (N4) — Knowledge research engine + per-agent packet split.
//
// Gathers background from free, key-less public APIs (Wikipedia MediaWiki action
// API; Semantic Scholar; PubMed; ArXiv), compiles a Markdown corpus, then splits
// it into overlapping-but-distinct packets (P10) and a per-round snippet pool.
// All network calls go through `httpGet` (retry + in-memory cache); one API
// failing never blocks the others. OFF by default — callers opt in.
//
// Every GET routes through the injected `fetchImpl` (default httpFetch) so the
// egress guard + tests can intercept. Tests can also inject `sleep` to skip
// real backoff delays.

import { FetchLike, httpFetch } from './http';
import { DEFAULT_OVERLAP_RATIO, KnowledgePacket, makeKnowledgePacket } from './types';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const SCHOLAR_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
const PUBMED_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ARXIV_API = 'https://export.arxiv.org/api/query';

const PUBMED_HINTS = [
  'bio',
  'med',
  'clinical',
  'protein',
  'gene',
  'enzyme',
  'cell',
  'drug',
  'disease',
] as const;
const ARXIV_HINTS = [
  'physics',
  'math',
  'quantum',
  'algorithm',
  'machine learning',
  'computation',
  'cs.',
] as const;

/** One search hit; shape mirrors the Python dicts (extra `id` for PubMed). */
export interface SearchResult {
  title: string;
  summary: string;
  source: string;
  id?: string;
}

/** Minimal embeddings dependency (frozen API: `embed` is async). */
export interface EmbeddingsLike {
  embed(texts: string[]): Promise<number[][]>;
}

/** Sleep helper (injectable so tests skip real backoff). */
export type SleepLike = (ms: number) => Promise<void>;

const realSleep: SleepLike = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Query params for a GET; values are stringified into the cache key + URL. */
type Params = Record<string, string | number>;

export class KnowledgeEngine {
  readonly timeout: number;
  readonly maxRetries: number;
  readonly retryBackoff: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  // Cache parsed bodies keyed by url+sorted-params (Python cached the Response).
  private readonly cache: Map<string, unknown> = new Map();

  constructor(
    timeout = 30,
    maxRetries = 2,
    retryBackoff = 0.5,
    fetchImpl: FetchLike = httpFetch,
    sleep: SleepLike = realSleep,
  ) {
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.retryBackoff = retryBackoff;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  // -- HTTP with retry + cache -----------------------------------------
  // `responseType` selects JSON (default) vs raw text (ArXiv XML). Mirrors the
  // Python retry policy: network errors retry then raise; >=500 retries then
  // raises via raise_for_status; success caches the parsed body.
  private async httpGet(url: string, params: Params, responseType: 'json' | 'text' = 'json'): Promise<unknown> {
    const key =
      url +
      '?' +
      Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&');
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    const qs = new URLSearchParams();
    for (const k of Object.keys(params)) {
      qs.set(k, String(params[k]));
    }
    const fullUrl = `${url}?${qs.toString()}`;
    const timeoutMs = this.timeout * 1000;

    let last: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(fullUrl, {
          method: 'GET',
          headers: { 'User-Agent': 'UnitCell/2.1 (research)' },
          signal: controller.signal,
        });
      } catch (exc) {
        clearTimeout(timer);
        last = exc;
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBackoff * 2 ** attempt * 1000);
          continue;
        }
        throw exc;
      }
      clearTimeout(timer);
      if (res.status >= 500 && attempt < this.maxRetries) {
        await this.sleep(this.retryBackoff * 2 ** attempt * 1000);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${fullUrl}`);
      }
      const body = responseType === 'text' ? await res.text() : await res.json();
      this.cache.set(key, body);
      return body;
    }
    throw new Error(`GET failed: ${String(last)}`);
  }

  // -- individual sources ----------------------------------------------
  async searchWikipedia(query: string, limit = 3): Promise<SearchResult[]> {
    const data = (await this.httpGet(WIKI_API, {
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: limit,
      format: 'json',
    })) as { query?: { search?: Array<Record<string, unknown>> } };
    const hits = data.query?.search ?? [];
    return hits.slice(0, limit).map((h) => ({
      title: String(h.title ?? ''),
      summary: stripHtml(String(h.snippet ?? '')),
      source: 'wikipedia',
    }));
  }

  async searchSemanticScholar(query: string, limit = 3): Promise<SearchResult[]> {
    const data = (await this.httpGet(SCHOLAR_API, {
      query,
      limit,
      fields: 'title,abstract',
    })) as { data?: Array<Record<string, unknown>> | null };
    const papers = data.data ?? [];
    return (papers ?? []).slice(0, limit).map((p) => ({
      title: String(p.title ?? ''),
      summary: String(p.abstract ?? '').slice(0, 600),
      source: 'semantic_scholar',
    }));
  }

  async searchPubmed(query: string, limit = 3): Promise<SearchResult[]> {
    const data = (await this.httpGet(PUBMED_API, {
      db: 'pubmed',
      term: query,
      retmax: limit,
      retmode: 'json',
    })) as { esearchresult?: { idlist?: string[] } };
    const ids = data.esearchresult?.idlist ?? [];
    return ids.slice(0, limit).map((pmid) => ({
      title: `PubMed:${pmid}`,
      summary: '',
      id: pmid,
      source: 'pubmed',
    }));
  }

  async searchArxiv(query: string, limit = 3): Promise<SearchResult[]> {
    const text = (await this.httpGet(
      ARXIV_API,
      { search_query: `all:${query}`, start: 0, max_results: limit },
      'text',
    )) as string;
    return parseArxiv(text).slice(0, limit);
  }

  // -- orchestration ----------------------------------------------------
  // Route queries to the relevant DBs and compile a Markdown corpus.
  // One source failing is logged inline and skipped — never fatal (P4).
  async routeSearch(topic: string, directives = '', limit = 3): Promise<string> {
    const blob = `${topic} ${directives}`.toLowerCase();
    const plan: Array<[string, (q: string, n: number) => Promise<SearchResult[]>]> = [
      ['Wikipedia', (q, n) => this.searchWikipedia(q, n)],
      ['Semantic Scholar', (q, n) => this.searchSemanticScholar(q, n)],
    ];
    if (PUBMED_HINTS.some((h) => blob.includes(h))) {
      plan.push(['PubMed', (q, n) => this.searchPubmed(q, n)]);
    }
    if (ARXIV_HINTS.some((h) => blob.includes(h))) {
      plan.push(['ArXiv', (q, n) => this.searchArxiv(q, n)]);
    }

    const sections: string[] = [`# Knowledge base: ${topic}\n`];
    for (const [name, fn] of plan) {
      let results: SearchResult[];
      try {
        results = await fn(topic, limit);
      } catch (exc) {
        sections.push(`## ${name}\n\n_(unavailable: ${String(exc)})_\n`);
        continue;
      }
      sections.push(`## ${name}\n`);
      for (const r of results) {
        const summary = (r.summary ?? '').trim();
        sections.push(`### ${r.title || 'untitled'}\n\n${summary}\n`);
      }
    }
    return sections.join('\n');
  }

  // -- packet split (P10) + snippet pool -------------------------------
  // Shared core (~overlapRatio) + asymmetric remainder split between A and B.
  splitPackets(corpus: string, overlapRatio: number = DEFAULT_OVERLAP_RATIO): KnowledgePacket {
    const units = splitUnits(corpus);
    if (units.length === 0) {
      return makeKnowledgePacket({ overlapRatio });
    }
    const kCore = Math.max(0, Math.min(units.length, roundHalfToEven(units.length * overlapRatio)));
    const core = units.slice(0, kCore);
    const rest = units.slice(kCore);
    const aExtra = rest.filter((_, i) => i % 2 === 0);
    const bExtra = rest.filter((_, i) => i % 2 === 1);
    return makeKnowledgePacket({
      forA: [...core, ...aExtra].join('\n\n'),
      forB: [...core, ...bExtra].join('\n\n'),
      sharedCore: core.join('\n\n'),
      overlapRatio,
    });
  }

  // Snippet pool for per-round attention-directed injection (P10).
  chunkCorpus(corpus: string, maxChars = 240): string[] {
    const snippets: string[] = [];
    for (let unit of splitUnits(corpus)) {
      unit = unit.trim();
      if (!unit || unit.startsWith('#')) {
        continue;
      }
      while (unit.length > maxChars) {
        // Python: `unit.rfind(" ", 0, maxChars) or maxChars` — a 0 index (space
        // at position 0) is falsy and falls back to maxChars; -1 (not found)
        // is truthy in Python so it cuts at -1 (drops last char). Preserve both.
        const idx = unit.lastIndexOf(' ', maxChars - 1);
        const cut = idx === 0 ? maxChars : idx === -1 ? unit.length - 1 : idx;
        snippets.push(unit.slice(0, cut).trim());
        unit = unit.slice(cut).trim();
      }
      if (unit) {
        snippets.push(unit);
      }
    }
    return snippets;
  }

  // Attach embeddings to the snippet pool (N10 integration).
  static async embedPool(
    snippets: string[],
    embeddings: EmbeddingsLike,
  ): Promise<Array<[string, number[]]>> {
    const vectors = await embeddings.embed(snippets);
    return snippets.map((s, i) => [s, vectors[i]]);
  }
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

// Python round(): banker's rounding (round-half-to-even). Used by splitPackets
// so the shared-core size matches the source on .5 boundaries (e.g. 5*0.5=2.5→2).
function roundHalfToEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

export function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
}

// Faithful ArXiv Atom parse: extract <entry> title/summary. Returns [] on
// malformed XML (mirrors the Python ET.ParseError guard).
export function parseArxiv(xmlText: string): SearchResult[] {
  const out: SearchResult[] = [];
  // Detect a parseable root <feed>/<entry>; bail out cleanly if absent.
  if (!/<\s*(feed|entry)[\s>]/i.test(xmlText)) {
    return out;
  }
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xmlText)) !== null) {
    const inner = m[1];
    const title = extractTag(inner, 'title');
    const summary = extractTag(inner, 'summary');
    out.push({ title, summary: summary.slice(0, 600), source: 'arxiv' });
  }
  return out;
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Split into paragraphs; if only one, fall back to sentences.
export function splitUnits(corpus: string): string[] {
  const paras = corpus
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paras.length > 1) {
    return paras;
  }
  const sentences = corpus
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length > 0) {
    return sentences;
  }
  return corpus.trim() ? [corpus.trim()] : [];
}
