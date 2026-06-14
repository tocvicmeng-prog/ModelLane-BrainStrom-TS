// Port of python/tests/test_embeddings.py (N10).
// HTTP mocked via injected fetchImpl; cache, cosine, fallback, dim guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EmbeddingsClient } from '../engine/embeddings';
import type { FetchLike } from '../engine/http';

// -- helpers ----------------------------------------------------------------

/** Fresh isolated cache dir per test (mirrors pytest's tmp_path). */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'emb-test-'));
}

/** Mirror of the Python _emb_payload(vectors) builder. */
function embPayload(vectors: number[][]): { data: Array<{ index: number; embedding: number[] }> } {
  return { data: vectors.map((v, i) => ({ index: i, embedding: v })) };
}

/** Build a Response-like object good enough for fetchJson (ok/status/json/text). */
function fakeResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** ~pytest.approx for floats. */
function assertApprox(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !~= ${expected}`);
}

// -- tests ------------------------------------------------------------------

test('embed_parses', async () => {
  const fetchImpl: FetchLike = (async () =>
    fakeResponse(200, embPayload([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]))) as unknown as FetchLike;
  const client = new EmbeddingsClient({ cacheDir: tmpDir(), fetchImpl });
  const vecs = await client.embed(['alpha', 'beta']);
  assert.deepEqual(vecs, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  assert.equal(client.degraded, false);
});

test('cache_hit', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] };
    const n = body.input.length;
    return fakeResponse(200, embPayload(Array.from({ length: n }, () => [1.0, 0.0])));
  }) as unknown as FetchLike;
  const client = new EmbeddingsClient({ cacheDir: tmpDir(), fetchImpl });
  await client.embed(['same text']);
  await client.embed(['same text']); // served from cache
  assert.equal(calls, 1);
});

test('cosine_known_vectors', () => {
  assertApprox(EmbeddingsClient.cosine([1, 0], [1, 0]), 1.0);
  assertApprox(EmbeddingsClient.cosine([1, 0], [0, 1]), 0.0);
  assertApprox(EmbeddingsClient.cosine([1, 0], [-1, 0]), -1.0);
  assert.equal(EmbeddingsClient.cosine([0, 0], [1, 1]), 0.0); // zero-norm guard
});

test('jaccard_fallback_sets_degraded', async () => {
  const fetchImpl: FetchLike = (async () => {
    throw new Error('no embeddings server');
  }) as unknown as FetchLike;
  const client = new EmbeddingsClient({ cacheDir: tmpDir(), fetchImpl });
  const vecs = await client.embed(['machine learning models', 'deep learning models']);
  assert.equal(client.degraded, true);
  assert.equal(vecs[0]!.length, 256); // fallback dimension
  // overlapping tokens -> positive cosine; identical -> 1.0
  assert.ok(EmbeddingsClient.cosine(vecs[0]!, vecs[1]!) > 0.0);
  assertApprox(EmbeddingsClient.cosine(vecs[0]!, vecs[0]!), 1.0);
});

test('dim_mismatch_raises', async () => {
  const fetchImpl: FetchLike = (async () =>
    fakeResponse(200, embPayload([[0.1, 0.2, 0.3]]))) as unknown as FetchLike; // 3-dim
  const client = new EmbeddingsClient({ cacheDir: tmpDir(), expectedDim: 8, fetchImpl });
  await assert.rejects(() => client.embed(['x']), /dim/);
});

test('mock_vectors_used', async () => {
  const client = new EmbeddingsClient({
    cacheDir: tmpDir(),
    mockVectors: { a: [1.0, 0.0], b: [0.0, 1.0] },
  });
  assert.deepEqual(await client.embed(['a', 'b']), [[1.0, 0.0], [0.0, 1.0]]);
});

test('jaccard_helper', () => {
  assertApprox(EmbeddingsClient.jaccard('the cat sat', 'the cat ran'), 2 / 4);
  assert.equal(EmbeddingsClient.jaccard('', ''), 0.0);
});
