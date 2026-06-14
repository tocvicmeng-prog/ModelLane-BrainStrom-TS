// research.test.ts — STRICT-TS port of python/tests/test_research.py (N4).
//
// The Python tests monkeypatch `requests.get`; the TS KnowledgeEngine routes every
// GET through an injected `fetchImpl: FetchLike`. The engine builds a full URL
// (`${api}?${querystring}`) before calling fetchImpl, so we dispatch the fake by
// URL substring exactly like the Python `_dispatch` helper (e.g. 'wikipedia' is in
// 'en.wikipedia.org', 'semanticscholar' / 'eutils' / 'arxiv' likewise).
//
// Mapping notes (snake_case Python -> camelCase TS):
//   * KnowledgeEngine().search_wikipedia(q)      -> new KnowledgeEngine().searchWikipedia(q)
//   * search_semantic_scholar / search_pubmed / search_arxiv -> searchSemanticScholar / searchPubmed / searchArxiv
//   * route_search(topic)                        -> routeSearch(topic)
//   * split_packets(corpus, overlap_ratio=)      -> splitPackets(corpus, overlapRatio)
//   * pkt.shared_core / for_a / for_b            -> pkt.sharedCore / forA / forB
//   * chunk_corpus(corpus)                       -> chunkCorpus(corpus)
//   * KnowledgeEngine.embed_pool(snips, client)  -> KnowledgeEngine.embedPool(snips, client)
//   * KnowledgeEngine(max_retries=, retry_backoff=) ->
//        new KnowledgeEngine(timeout, maxRetries, retryBackoff, fetchImpl, sleep)
//
// PubMed's TS port yields title `PubMed:<id>` + `id` field (Python returned an
// 'id' key); the pytest only checks the id list + source, which we preserve.
// A no-op sleep is injected everywhere so retry backoff never delays the tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeEngine } from '../engine/research';
import type { SleepLike } from '../engine/research';
import type { FetchLike } from '../engine/http';
import { EmbeddingsClient } from '../engine/embeddings';

const ARXIV_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Quantum Foo</title><summary>A study of foo.</summary></entry>
</feed>`;

// Inject so retry backoff never actually waits.
const noSleep: SleepLike = async () => {};

/** Response-like good enough for KnowledgeEngine.httpGet (ok/status/json/text). */
function fakeResponse(status: number, payload?: unknown, text = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => payload ?? {},
    text: async () => text,
  } as unknown as Response;
}

type Route = Response | Error | (() => Response);

/** Build a fake fetch that routes by URL substring (mirror of Python _dispatch). */
function dispatch(mapping: Record<string, Route>): FetchLike {
  return (async (url: string) => {
    for (const needle of Object.keys(mapping)) {
      if (url.includes(needle)) {
        const route = mapping[needle]!;
        if (typeof route === 'function') {
          return route();
        }
        if (route instanceof Error) {
          throw route;
        }
        return route;
      }
    }
    return fakeResponse(404, {});
  }) as unknown as FetchLike;
}

// ---------------------------------------------------------------------------

test('search_wikipedia_parses', async () => {
  const payload = {
    query: { search: [{ title: 'Photosynthesis', snippet: '<span>green</span> plants' }] },
  };
  const eng = new KnowledgeEngine(30, 2, 0, dispatch({ wikipedia: fakeResponse(200, payload) }), noSleep);
  const out = await eng.searchWikipedia('photosynthesis');
  assert.equal(out[0]!.title, 'Photosynthesis');
  assert.equal(out[0]!.summary, 'green plants'); // HTML stripped
  assert.equal(out[0]!.source, 'wikipedia');
});

test('search_semantic_scholar_parses', async () => {
  const payload = { data: [{ title: 'On Catalysis', abstract: 'We study catalysis.' }] };
  const eng = new KnowledgeEngine(30, 2, 0, dispatch({ semanticscholar: fakeResponse(200, payload) }), noSleep);
  const out = await eng.searchSemanticScholar('catalysis');
  assert.equal(out[0]!.title, 'On Catalysis');
  assert.ok(out[0]!.summary.toLowerCase().includes('catalysis'));
});

test('search_pubmed_parses', async () => {
  const payload = { esearchresult: { idlist: ['111', '222'] } };
  const eng = new KnowledgeEngine(30, 2, 0, dispatch({ eutils: fakeResponse(200, payload) }), noSleep);
  const out = await eng.searchPubmed('protein folding');
  assert.deepEqual(out.map((r) => r.id), ['111', '222']);
  assert.equal(out[0]!.source, 'pubmed');
});

test('search_arxiv_parses', async () => {
  const eng = new KnowledgeEngine(30, 2, 0, dispatch({ arxiv: fakeResponse(200, undefined, ARXIV_XML) }), noSleep);
  const out = await eng.searchArxiv('quantum');
  assert.equal(out[0]!.title, 'Quantum Foo');
  assert.ok(out[0]!.summary.toLowerCase().includes('foo'));
});

test('route_search_output_format', async () => {
  const mapping: Record<string, Route> = {
    wikipedia: fakeResponse(200, { query: { search: [{ title: 'T1', snippet: 's1' }] } }),
    semanticscholar: fakeResponse(200, { data: [{ title: 'P1', abstract: 'a1' }] }),
  };
  const eng = new KnowledgeEngine(30, 2, 0, dispatch(mapping), noSleep);
  const md = await eng.routeSearch('a neutral topic');
  assert.ok(md.startsWith('# Knowledge base:'));
  assert.ok(md.includes('## Wikipedia'));
  assert.ok(md.includes('## Semantic Scholar'));
});

test('retry_on_failure', async () => {
  const seq: Response[] = [
    fakeResponse(503),
    fakeResponse(200, { query: { search: [{ title: 'OK', snippet: 'x' }] } }),
  ];
  const fetchImpl: FetchLike = (async () => seq.shift()!) as unknown as FetchLike;
  const eng = new KnowledgeEngine(30, 2, 0, fetchImpl, noSleep);
  const out = await eng.searchWikipedia('q');
  assert.equal(out[0]!.title, 'OK');
  assert.deepEqual(seq, []);
});

test('cache_hit', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (async () => {
    calls += 1;
    return fakeResponse(200, { query: { search: [{ title: 'C', snippet: 'x' }] } });
  }) as unknown as FetchLike;
  const eng = new KnowledgeEngine(30, 2, 0, fetchImpl, noSleep);
  await eng.searchWikipedia('same');
  await eng.searchWikipedia('same');
  assert.equal(calls, 1);
});

test('partial_failure_graceful', async () => {
  const mapping: Record<string, Route> = {
    wikipedia: fakeResponse(200, { query: { search: [{ title: 'WikiHit', snippet: 's' }] } }),
    semanticscholar: new Error('scholar down'),
  };
  const eng = new KnowledgeEngine(30, 1, 0, dispatch(mapping), noSleep);
  const md = await eng.routeSearch('a neutral topic');
  assert.ok(md.includes('WikiHit')); // Wikipedia still returned
  assert.ok(md.includes('unavailable')); // Scholar failure noted, not fatal
});

test('split_packets_shared_core_and_asymmetric', () => {
  const corpus = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} content.`).join('\n\n');
  const pkt = new KnowledgeEngine().splitPackets(corpus, 0.5);
  assert.ok(pkt.sharedCore);
  assert.ok(pkt.forA.includes(pkt.sharedCore) && pkt.forB.includes(pkt.sharedCore));
  assert.notEqual(pkt.forA, pkt.forB); // asymmetric remainder
});

test('chunk_corpus_and_embed_pool', async () => {
  const corpus =
    '# Heading\n\nFirst fact about enzymes. Second fact about kinetics.\n\nThird paragraph here.';
  const snippets = new KnowledgeEngine().chunkCorpus(corpus);
  assert.ok(snippets.length > 0 && snippets.every((s) => typeof s === 'string'));
  assert.ok(!snippets.some((s) => s.startsWith('#'))); // headings dropped
  const client = new EmbeddingsClient({ mockVectors: {} }); // deterministic lexical vectors
  const pool = await KnowledgeEngine.embedPool(snippets, client);
  assert.equal(pool.length, snippets.length);
  assert.ok(pool.every(([, vec]) => vec.length > 0));
});
