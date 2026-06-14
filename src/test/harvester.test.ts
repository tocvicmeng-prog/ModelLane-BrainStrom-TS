// Port of python/tests/test_harvester.py (N13).
// Continuous capture; the v2.0 CLASH leak fix. Extractor is duck-typed and
// mocked with a queued FakeExtractor (zero tokens, no network/subprocess).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Harvester, type Extractor } from '../engine/harvester';
import { HarvestSource, Phase, type ChatMessage } from '../engine/types';

// ---------------------------------------------------------------------------
// Fixtures — inlined from python/tests/fixtures/mock_harvest.json so the test
// is self-contained and deterministic (mirrors the pytest _fx loader).
// ---------------------------------------------------------------------------

interface RawItem {
  text: string;
  author_agent?: string;
}

const FIXTURES: Record<string, RawItem[]> = {
  two_atomic: [
    {
      text: 'The catalyst lowers activation energy by stabilising the transition state',
      author_agent: 'A',
    },
    {
      text: 'Reusing the catalyst across batches cuts per-unit cost substantially',
      author_agent: 'B',
    },
  ],
  with_pronoun: [
    { text: 'It reduces cost by reusing the catalyst across many batches', author_agent: 'A' },
  ],
  near_dup: [
    { text: 'reusing the catalyst lowers the overall cost', author_agent: 'A' },
    { text: 'reusing the catalyst lowers the overall cost', author_agent: 'B' },
  ],
  with_trivial: [
    { text: 'Yes.', author_agent: 'A' },
    {
      text: 'The transition-state analog lowers the reaction barrier markedly',
      author_agent: 'B',
    },
  ],
  extract_one: [
    { text: 'A staged reactor design improves yield under mild conditions', author_agent: 'A' },
  ],
  omission_one: [
    { text: 'Counter-current flow recovers waste heat and raises efficiency', author_agent: 'B' },
  ],
  omission_dry: [],
};

function fx(name: string): RawItem[] {
  return FIXTURES[name]!;
}

// ---------------------------------------------------------------------------
// FakeExtractor — duck-typed extractor returning queued canned responses.
// Mirrors the pytest FakeExtractor: serialises each queued response to JSON,
// returns the last when exhausted, and counts calls.
// ---------------------------------------------------------------------------

class FakeExtractor implements Extractor {
  responses: string[];
  modelFamily: string;
  calls = 0;

  constructor(responses: Array<RawItem[] | string>, modelFamily = 'bwm-fam') {
    this.responses = responses.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
    this.modelFamily = modelFamily;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async speak(_conversation: ChatMessage[], _temperature?: number): Promise<string> {
    const idx = this.responses.length ? Math.min(this.calls, this.responses.length - 1) : 0;
    this.calls += 1;
    return this.responses.length ? this.responses[idx]! : '[]';
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('harvest_extracts_atomic_insights', async () => {
  const ex = new FakeExtractor([fx('two_atomic')]);
  const recs = await new Harvester(ex).harvestRound('A: ... B: ...', { phase: 'clash' }, 'economy');
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => Boolean(r.text)));
  assert.ok(recs.every((r) => r.id.startsWith('ins-')));
});

test('decontextualization_resolves_refs', async () => {
  const ex = new FakeExtractor([fx('with_pronoun')]);
  const recs = await new Harvester(ex).harvestRound(
    'transcript',
    { phase: 'propose', subject: 'the immobilised enzyme' },
    'economy',
  );
  // leading pronoun resolved against the known subject
  assert.ok(recs[0]!.text.startsWith('the immobilised enzyme'));
});

test('dedup_before_ingest', async () => {
  const ex = new FakeExtractor([fx('near_dup')]);
  // thetaDup=0.9 via constructor; embeddings=null, second=null then thetaDup.
  const h = new Harvester(ex, null, null, 0.9);
  const recs = await h.harvestRound('t', { phase: 'clash' }, 'economy');
  assert.equal(recs.length, 1); // identical texts collapse (Jaccard 1.0)
});

test('abstain_on_simple_claim', async () => {
  const ex = new FakeExtractor([fx('with_trivial')]);
  const recs = await new Harvester(ex).harvestRound('t', { phase: 'clash' }, 'economy');
  assert.equal(recs.length, 1); // "Yes." abstained, substantive kept
  assert.ok(recs[0]!.text.includes('transition-state'));
});

test('omission_loop_until_dry', async () => {
  // extract -> [A]; omission#1 -> [B] (new); omission#2 -> [] (dry, stop)
  const ex = new FakeExtractor([fx('extract_one'), fx('omission_one'), fx('omission_dry')]);
  // maxHarvestPasses=3 is the 6th positional arg (extractor, embeddings, second, thetaDup, minChars, maxHarvestPasses)
  const h = new Harvester(ex, null, null, undefined, undefined, 3);
  const recs = await h.harvestRound('t', { phase: 'clash' }, 'high_stakes');
  assert.equal(recs.length, 2);
  assert.equal(h.lastOmissionPasses, 2); // ran until a pass added nothing
});

test('clash_insights_captured', async () => {
  // Insights surfacing in a CLASH move rationale must be captured (v2.0 leak).
  const ex = new FakeExtractor([fx('two_atomic')]);
  const recs = await new Harvester(ex).harvestRound(
    'B: I REBUT because the mechanism actually...',
    { phase: Phase.CLASH, author_model_family: 'fam-a' },
    'economy',
  );
  assert.ok(recs.length > 0);
  assert.ok(recs.every((r) => r.sourcePhase === Phase.CLASH));
  assert.ok(recs.every((r) => r.harvestedFrom === HarvestSource.MOVE_RATIONALE));
});

test('economy_tier_single_pass_no_omission', async () => {
  const ex = new FakeExtractor([fx('extract_one'), fx('omission_one')]);
  const h = new Harvester(ex);
  await h.harvestRound('t', { phase: 'clash' }, 'economy');
  assert.equal(ex.calls, 1); // exactly one extraction, no omission loop
  assert.equal(h.lastOmissionPasses, 0);
});
