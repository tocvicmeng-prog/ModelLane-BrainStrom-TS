// Port of python/tests/test_metrics.py (N12) — pure math over deterministic
// embeddings. No network, no subprocess, no tokens. The IdeaLedger ingest paths
// are async in the TS port (ledger.ts) so each builder awaits; otherwise the
// assertions/intent mirror the pytest one-to-one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IdeaLedger } from '../engine/ledger';
import {
  captureCoverage,
  computeEntropyMetrics,
  coverageReport,
  estimatedRecall,
  fixationCheck,
  openingDiversity,
  openingDiversityBelowFloor,
  verificationPassRate,
} from '../engine/metrics';
import { InsightStatus, IdeaRecord, InsightRecord, makeIdeaRecord, makeInsightRecord } from '../engine/types';

// pytest.approx replacement (default rel=1e-6, with a small abs floor for 0.0).
function approxEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol + 1e-6 * Math.abs(b);
}

// _led(records): build a ledger and ingest the idea slips (async in the port).
async function led(records: IdeaRecord[]): Promise<IdeaLedger> {
  const l = new IdeaLedger();
  await l.ingest(records);
  return l;
}

// _idea(i, vec, quality=6.0, agent="A", rnd=0)
function idea(
  i: number,
  vec: number[],
  quality = 6.0,
  agent = 'A',
  rnd = 0,
): IdeaRecord {
  return makeIdeaRecord({
    id: `i${i}`,
    text: `idea ${i}`,
    agent,
    roundNumber: rnd,
    embedding: vec,
    quality,
  });
}

test('test_cluster_entropy_uniform_vs_peaked', async () => {
  const peaked = await led([0, 1, 2, 3].map((i) => idea(i, [1.0, 0.0, 0.0, 0.0])));
  const uniform = await led([
    idea(0, [1, 0, 0, 0]),
    idea(1, [0, 1, 0, 0]),
    idea(2, [0, 0, 1, 0]),
    idea(3, [0, 0, 0, 1]),
  ]);
  const ep = computeEntropyMetrics(peaked);
  const eu = computeEntropyMetrics(uniform);
  assert.ok(approxEqual(ep.clusterEntropy, 0.0)); // one cluster
  assert.ok(eu.clusterEntropy > ep.clusterEntropy); // spread across clusters
  assert.ok(approxEqual(eu.clusterEntropyNorm, 1.0));
});

test('test_sigma_self_info_higher_for_heavy_tail', async () => {
  const ortho = await led([idea(0, [1, 0, 0]), idea(1, [0, 1, 0]), idea(2, [0, 0, 1])]);
  const heavy = await led([
    idea(0, [1.0, 0.0, 0.0]),
    idea(1, [0.99, 0.01, 0.0]),
    idea(2, [0.98, 0.02, 0.0]),
    idea(3, [0.0, 0.0, 1.0]),
  ]);
  const eo = computeEntropyMetrics(ortho);
  const eh = computeEntropyMetrics(heavy);
  assert.ok(eh.stdSelfInfo > eo.stdSelfInfo); // an outlier widens σ_SI
  assert.ok(eh.stdSelfInfo > 0.0);
});

test('test_fluency_controlled_originality', async () => {
  // only ideas with quality >= 6 contribute; none qualifying → 0.0
  const low = await led([idea(0, [1, 0], 2.0), idea(1, [0, 1], 3.0)]);
  assert.equal(computeEntropyMetrics(low).fluencyControlledOriginality, 0.0);
  const mixed = await led([idea(0, [1, 0], 8.0), idea(1, [0, 1], 1.0)]);
  assert.ok(computeEntropyMetrics(mixed).fluencyControlledOriginality >= 0.0);
});

test('test_opening_diversity_gate', async () => {
  const diverse = await led([idea(0, [1, 0], 6.0, 'A', 0), idea(1, [0, 1], 6.0, 'B', 0)]);
  assert.ok(approxEqual(openingDiversity(diverse), 1.0));
  assert.ok(!openingDiversityBelowFloor(diverse));
  const collapsed = await led([idea(0, [1, 0], 6.0, 'A', 0), idea(1, [1, 0], 6.0, 'B', 0)]);
  assert.ok(approxEqual(openingDiversity(collapsed), 0.0));
  assert.ok(openingDiversityBelowFloor(collapsed)); // would trigger a re-seed
});

test('test_fixation_flag', async () => {
  const fix = new IdeaLedger();
  await fix.ingest([
    idea(0, [1, 0], 6.0, 'A', 0),
    idea(1, [0, 1], 6.0, 'B', 0),
    idea(2, [1, 0], 6.0, 'A', 1),
    idea(3, [1, 0], 6.0, 'B', 1),
  ]);
  assert.equal(fixationCheck(fix, 1), true); // sim jumped 0 -> 1
  const nofix = new IdeaLedger();
  await nofix.ingest([
    idea(0, [1, 0], 6.0, 'A', 0),
    idea(1, [0, 1], 6.0, 'B', 0),
    idea(2, [1, 0], 6.0, 'A', 1),
    idea(3, [0, 1], 6.0, 'B', 1),
  ]);
  assert.equal(fixationCheck(nofix, 1), false);
});

test('test_verification_pass_rate', () => {
  const insights: InsightRecord[] = [
    makeInsightRecord({ id: 'a', text: 'x', status: InsightStatus.GROUNDED }),
    makeInsightRecord({ id: 'b', text: 'y', status: InsightStatus.SCRUTINIZED }),
    makeInsightRecord({ id: 'c', text: 'z', status: InsightStatus.UNVERIFIABLE }),
    makeInsightRecord({ id: 'd', text: 'w', status: InsightStatus.CAPTURED }),
  ];
  assert.ok(approxEqual(verificationPassRate(insights), 0.5)); // 2 of 4 verified
  assert.equal(verificationPassRate([]), 0.0);
});

test('test_capture_coverage_and_report', async () => {
  assert.ok(approxEqual(captureCoverage(3, 4), 0.75));
  assert.equal(captureCoverage(5, 4), 1.0); // clamped
  assert.equal(captureCoverage(3, null), 0.0);
  const l = new IdeaLedger();
  await l.ingestInsights([
    makeInsightRecord({ id: 'x1', text: 't1' }),
    makeInsightRecord({ id: 'x2', text: 't2' }),
  ]);
  const rep = coverageReport(l, 4, 1, 0.6);
  assert.equal(rep.capturedUnionCount, 2);
  assert.ok(approxEqual(rep.coverage, 0.5));
  assert.equal(rep.goldSetRecall, 0.6); // the one honest number
  assert.equal(rep.omissionPassCount, 1);
});

test('test_estimated_recall_is_telemetry', () => {
  const r = estimatedRecall(10, 8, 6);
  assert.ok(r !== null && 0.0 <= r && r <= 1.0);
  assert.equal(estimatedRecall(0, 5, 0), null); // degenerate → None
});

test('test_sigma_si_primary_verified_secondary', async () => {
  const plain = await led([idea(0, [1, 0, 0]), idea(1, [0, 1, 0]), idea(2, [0, 0, 1])]);
  const em = computeEntropyMetrics(plain);
  assert.equal(typeof em.stdSelfInfo, 'number'); // σ_SI always computed (primary)
  assert.equal(em.stdSelfInfoVerified, null); // no verified ideas → None (secondary)

  const verified = new IdeaLedger();
  await verified.ingestInsights([
    makeInsightRecord({
      id: 'v1',
      text: 'alpha insight',
      embedding: [1, 0, 0],
      status: InsightStatus.GROUNDED,
      survivedScrutiny: 0.8,
    }),
    makeInsightRecord({
      id: 'v2',
      text: 'beta insight',
      embedding: [0, 1, 0],
      status: InsightStatus.SCRUTINIZED,
      survivedScrutiny: 0.6,
    }),
  ]);
  const emv = computeEntropyMetrics(verified);
  assert.notEqual(emv.stdSelfInfoVerified, null); // verified-σ now reported (secondary)
});
