// Port of python/tests/test_ledger.py (N11) — IdeaLedger provenance, dedup,
// good-idea count, marginal diversity, novelty rate, CLASH-insight mirroring,
// KPA clustering, and the lexical (Jaccard) fallback. Deterministic via explicit
// embeddings supplied on the records (no embeddings client, hence no HTTP) — the
// ledger's ensureEmbeddings short-circuits when embeddings === null, mirroring
// the Python test's "no HTTP" determinism. The lexical-fallback test relies on
// the same null-embeddings path so similarity() takes the Jaccard branch.
//
// Naming map: IdeaRecord(...) dataclass -> makeIdeaRecord({...}) factory;
// InsightRecord(...) -> makeInsightRecord({...}); snake_case -> camelCase
// (round_number -> roundNumber, model_family -> modelFamily, parent_ids ->
// parentIds, source_phase -> sourcePhase, span_type -> spanType, harvested_from
// -> harvestedFrom, author_model_family -> authorModelFamily). IdeaStatus.MERGED
// .value (Python) -> IdeaStatus.MERGED (TS string union value). Constructor
// keyword IdeaLedger(theta_dup=...) maps to the 2nd positional arg
// IdeaLedger(embeddings=null, thetaDup=...). ingest/ingestInsights are async.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IdeaLedger } from '../engine/ledger';
import {
  IdeaRecord,
  IdeaStatus,
  makeIdeaRecord,
  makeInsightRecord,
} from '../engine/types';

// Mirrors the Python `_idea(idx, vec, quality=6.0, agent="A", rnd=0, text=None)`
// fixture helper, including its dataclass defaults (phase="propose",
// model_family="fam").
function idea(
  idx: number,
  vec: number[],
  opts: { quality?: number; agent?: string; rnd?: number; text?: string } = {},
): IdeaRecord {
  return makeIdeaRecord({
    id: `i${idx}`,
    text: opts.text ?? `idea ${idx}`,
    agent: opts.agent ?? 'A',
    roundNumber: opts.rnd ?? 0,
    phase: 'propose',
    modelFamily: 'fam',
    embedding: vec,
    quality: opts.quality ?? 6.0,
  });
}

test('ingest_provenance', async () => {
  const led = new IdeaLedger();
  await led.ingest([
    makeIdeaRecord({
      id: 'i1',
      text: 'x',
      agent: 'B',
      roundNumber: 3,
      phase: 'propose',
      modelFamily: 'gemma',
      parentIds: ['i0'],
    }),
  ]);
  const rec = led.ideas[0]!;
  assert.equal(rec.agent, 'B');
  assert.equal(rec.roundNumber, 3);
  assert.equal(rec.modelFamily, 'gemma');
  assert.deepEqual(rec.parentIds, ['i0']);
});

test('dedup_merges_near_duplicates', async () => {
  const led = new IdeaLedger(null, 0.92);
  await led.ingest([
    idea(1, [1.0, 0.0]),
    idea(2, [1.0, 0.0]),
    idea(3, [0.0, 1.0]),
  ]);
  const merged = led.dedup();
  assert.equal(merged, 1); // idea 2 is a clone of idea 1
  assert.equal(led.n, 2); // only 2 distinct ideas remain active
  const statuses = new Map<string, string>(led.ideas.map((i) => [i.id, i.status]));
  assert.equal(statuses.get('i2'), IdeaStatus.MERGED);
});

test('good_idea_count_threshold', async () => {
  const led = new IdeaLedger();
  await led.ingest([
    idea(1, [1, 0, 0], { quality: 7.0 }),
    idea(2, [0, 1, 0], { quality: 5.0 }),
    idea(3, [0, 0, 1], { quality: 8.0 }),
  ]);
  assert.equal(led.goodIdeaCount(6.0), 2);
});

test('marginal_diversity_decreases_on_clone', async () => {
  const base = new IdeaLedger();
  await base.ingest([
    idea(1, [1.0, 0.0], { quality: 8.0 }),
    idea(2, [0.0, 1.0], { quality: 7.0 }),
  ]);
  const mdBase = base.marginalDiversity();

  const cloned = new IdeaLedger();
  await cloned.ingest([
    idea(1, [1.0, 0.0], { quality: 8.0 }),
    idea(2, [0.0, 1.0], { quality: 7.0 }),
    idea(3, [1.0, 0.0], { quality: 6.0 }), // clone of idea 1
  ]);
  const mdClone = cloned.marginalDiversity(); // computed BEFORE dedup
  assert.ok(mdClone < mdBase); // the near-duplicate drags MD down
});

test('novelty_rate', async () => {
  const led = new IdeaLedger(null, 0.92);
  await led.ingest([
    idea(1, [1.0, 0.0], { rnd: 2 }),
    idea(2, [0.0, 1.0], { rnd: 2 }),
    idea(3, [1.0, 0.0], { rnd: 2 }), // idea 3 clones idea 1
  ]);
  led.dedup();
  // pytest.approx(2 / 3): 2 of 3 survived
  const APPROX = 1e-9;
  assert.ok(Math.abs(led.noveltyRate(2) - 2 / 3) < APPROX);
  assert.equal(led.noveltyRate(99), 0.0); // no ideas in that round
});

test('clash_insights_enter_ledger', async () => {
  // The v2.0 leak fix: insights harvested in CLASH must reach the ledger.
  const led = new IdeaLedger();
  const ins = makeInsightRecord({
    id: 'x1',
    text: 'novel mechanism',
    sourcePhase: 'clash',
    spanType: 'move_rationale',
    harvestedFrom: 'move_rationale',
    authorModelFamily: 'fam-a',
    embedding: [1.0, 0.0],
  });
  await led.ingestInsights([ins]);
  assert.equal(led.insights[0]!.id, 'x1'); // kept as InsightRecord
  const mirrored = led.ideas.filter((i) => i.id === 'x1');
  assert.ok(mirrored.length > 0);
  assert.equal(mirrored[0]!.harvestedFrom, 'move_rationale');
  assert.equal(mirrored[0]!.phase, 'clash'); // provenance preserved
});

test('kpa_cluster', async () => {
  const led = new IdeaLedger();
  const recs = [
    idea(1, [1.0, 0.0, 0.0]),
    idea(2, [1.0, 0.1, 0.0]),
    idea(3, [0.0, 1.0, 0.0]),
  ];
  const clusters = led.kpaCluster(recs, 0.75);
  assert.equal(clusters.length, 2); // ideas 1&2 cluster, 3 alone
  const sizes = clusters.map((c) => c.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [1, 2]);
});

test('lexical_fallback_without_embeddings', async () => {
  const led = new IdeaLedger(null, 0.9);
  await led.ingest([
    makeIdeaRecord({ id: 'a', text: 'reduce activation energy via catalyst' }),
    makeIdeaRecord({ id: 'b', text: 'reduce activation energy via catalyst' }),
  ]);
  // identical text -> Jaccard 1.0 -> merged
  assert.equal(led.dedup(), 1);
});
