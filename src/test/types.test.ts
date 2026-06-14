// Port of python/tests/test_types.py (N1) — pure data-model invariants + a
// persistence round-trip. The Python module's save/load/query SQLite+file layer
// lives OUTSIDE this faithful TS port (see engine/types.ts header), so the
// round-trip test exercises the in-process JSON serialisation helpers
// (toJsonable -> JSON -> fromJsonable, the load equivalent) and the
// unitResultToSummary derivation (the to_summary / query-row equivalent),
// preserving the same assertions/intent. No network, no subprocess, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ComplexityFlag,
  InsightStatus,
  NormalizedScores,
  ResultType,
  RigorTier,
  UnitResult,
  UnitSummary,
  VERIFIED_STATUSES,
  classifyResult,
  clamp01,
  createSessionId,
  fromJsonable,
  insightToIdeaRecord,
  makeAgentConfig,
  makeCoverageReport,
  makeDimScores,
  makeEntropyMetrics,
  makeIdeaRecord,
  makeInsightRecord,
  makeKeyPoint,
  makeNormalizedScores,
  makeRoundScore,
  makeScoringScale,
  makeUnitConfig,
  makeUnitResult,
  makeVerificationRecord,
  makeWeightVector,
  normalizedScoresAllInUnit,
  scoringScaleIsValid,
  toJsonable,
  unitResultToSummary,
} from '../engine/types';

// pytest.approx replacement: absolute+relative tolerance comparable to pytest's
// default (rel=1e-6). For the integer-ish values checked here a tight abs is fine.
function approxEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol + 1e-6 * Math.abs(b);
}

test('test_unitconfig_defaults', () => {
  const cfg = makeUnitConfig();
  assert.ok(cfg.tokenBudget > 0);
  assert.ok(cfg.maxRounds >= 1);
  assert.ok(scoringScaleIsValid(cfg.scoringScale));
  assert.ok(cfg.overlapRatio > 0.0 && cfg.overlapRatio < 1.0);
  assert.equal(cfg.rigorTier, RigorTier.STANDARD);
  // diversity levers: A and B default to distinct families (LD8 enforceable)
  assert.notEqual(cfg.agentA.modelFamily, cfg.agentB.modelFamily);
  // role temperatures: brainstorm hot, verify cold (LD8)
  assert.ok(cfg.generatorTemp > cfg.verifierTemp);
});

test('test_scoringscale_invariants', () => {
  assert.ok(scoringScaleIsValid(makeScoringScale())); // 3 > 1 >= 0
  assert.ok(scoringScaleIsValid(makeScoringScale({ win: 10, draw: 5, loss: 0 })));
  assert.ok(!scoringScaleIsValid(makeScoringScale({ win: 1, draw: 1, loss: 0 }))); // win == draw
  assert.ok(!scoringScaleIsValid(makeScoringScale({ win: 3, draw: 0, loss: 1 }))); // draw < loss
});

test('test_agentscore_normalization', () => {
  const ok: NormalizedScores = makeNormalizedScores({
    vNormA: 0.7,
    vNormB: 0.3,
    validityDifferential: 0.4,
    engagementV2: 0.5,
    violationRate: 0.0,
  });
  assert.ok(normalizedScoresAllInUnit(ok));
  const bad: NormalizedScores = makeNormalizedScores({ vNormA: 1.4 });
  assert.ok(!normalizedScoresAllInUnit(bad));
  assert.equal(clamp01(1.4), 1.0);
  assert.equal(clamp01(-0.2), 0.0);
  assert.equal(clamp01(0.5), 0.5);
});

test('test_weightvector_composite_range', () => {
  const wv = makeWeightVector({
    tailScore: 0.8,
    marginalDiversity: 0.5,
    goodIdeaCountNorm: 0.4,
    judgeReliability: 0.9,
    composite: 0.66,
  });
  assert.ok(wv.composite >= 0.0 && wv.composite <= 1.0);
  assert.equal(makeWeightVector({ disqualified: true, composite: 0.0 }).composite, 0.0);
});

test('test_resulttype_classification', () => {
  // validity differential thresholds: >=0.6 decisive, >=0.3 tilted, else controversial
  assert.equal(classifyResult(0.7, 0.0)[0], ResultType.DECISIVE);
  assert.equal(classifyResult(0.6, 0.0)[0], ResultType.DECISIVE); // boundary
  assert.equal(classifyResult(0.45, 0.0)[0], ResultType.TILTED);
  assert.equal(classifyResult(0.3, 0.0)[0], ResultType.TILTED); // boundary
  assert.equal(classifyResult(0.1, 0.0)[0], ResultType.CONTROVERSIAL);
  // complexity from generativity / σ_SI
  assert.equal(classifyResult(0.0, 0.7)[1], ComplexityFlag.HIGH); // good_idea_count_norm >= 0.6
  assert.equal(classifyResult(0.0, 0.0, 2.0, 1.5)[1], ComplexityFlag.HIGH);
  assert.equal(classifyResult(0.0, 0.1)[1], ComplexityFlag.LOW);
  assert.equal(classifyResult(0.0, 0.4)[1], ComplexityFlag.NORMAL);
});

test('test_insight_status_enum_and_verified_set', () => {
  assert.deepEqual(
    new Set(Object.values(InsightStatus)),
    new Set(['captured', 'grounded', 'scrutinized', 'refuted', 'unverifiable', 'quarantined']),
  );
  // UNVERIFIABLE / REFUTED / CAPTURED never count as verified (P16 incentive rule)
  assert.ok(VERIFIED_STATUSES.includes(InsightStatus.GROUNDED));
  assert.ok(VERIFIED_STATUSES.includes(InsightStatus.SCRUTINIZED));
  assert.ok(!VERIFIED_STATUSES.includes(InsightStatus.UNVERIFIABLE));
  assert.ok(!VERIFIED_STATUSES.includes(InsightStatus.REFUTED));
});

test('test_originality_and_feasibility_are_separate', () => {
  // P8: never combine the two criteria into one number.
  const idea = makeIdeaRecord({ id: 'i1', text: 'x', originality: 0.9, feasibility: 0.2 });
  assert.notEqual(idea.originality, idea.feasibility);
  const kp = makeKeyPoint({ id: 'k1', text: 'x', originality: 0.9, feasibility: 0.2 });
  assert.equal(kp.originality, 0.9);
  assert.equal(kp.feasibility, 0.2);
});

test('test_entropy_metrics_ranges', () => {
  const em = makeEntropyMetrics({ clusterEntropy: 1.2, clusterEntropyNorm: 0.8, stdSelfInfo: 0.5 });
  assert.ok(em.clusterEntropyNorm >= 0.0 && em.clusterEntropyNorm <= 1.0);
  assert.equal(em.stdSelfInfoVerified, null); // secondary, optional
});

test('test_verifier_family_differs_from_author_is_representable', () => {
  const ins = makeInsightRecord({ id: 'x1', text: 'atomic claim', authorModelFamily: 'family-a' });
  const vr = makeVerificationRecord({
    id: 'v1',
    insightId: 'x1',
    verifierModelFamily: 'family-b',
    status: InsightStatus.GROUNDED,
    survivedScrutiny: 0.8,
  });
  assert.notEqual(vr.verifierModelFamily, ins.authorModelFamily); // LD8 invariant
  assert.equal(vr.pEstimate, null); // export-only telemetry, not set here
});

test('test_insight_to_idea_record_links_by_id', () => {
  // The TS port exposes this as the free function insightToIdeaRecord (the
  // Python InsightRecord.to_idea_record() instance method).
  const ins = makeInsightRecord({
    id: 'x9',
    text: 't',
    survivedScrutiny: 0.7,
    status: InsightStatus.SCRUTINIZED,
  });
  const idea = insightToIdeaRecord(ins);
  assert.equal(idea.id, 'x9');
  assert.equal(idea.verificationStatus, InsightStatus.SCRUTINIZED);
  assert.equal(idea.survivedScrutiny, 0.7);
});

test('test_save_load_query_roundtrip', () => {
  // The Python save/load/query SQLite+file persistence is intentionally NOT in
  // this faithful TS port (engine/types.ts header). We exercise the in-process
  // equivalents that DO live in the port:
  //   - save+load round-trip  -> toJsonable -> JSON -> fromJsonable
  //   - query() summary rows  -> unitResultToSummary (== Python to_summary)
  //   - the query result_type filter -> in-memory predicate over the summary
  // The asserted fields mirror the pytest exactly.
  const result: UnitResult = makeUnitResult({
    unitId: 'unit-test-1', // set explicitly (no SQLite/uuid mint in the port)
    topic: 'Test topic',
    agentAName: 'A',
    agentBName: 'B',
    normalized: makeNormalizedScores({ vNormA: 0.6, vNormB: 0.4, validityDifferential: 0.2 }),
    weights: makeWeightVector({ tailScore: 0.7, composite: 0.55, goodIdeaCount: 4 }),
    ideaLedger: [makeIdeaRecord({ id: 'i1', text: 'idea one', originality: 0.5, feasibility: 0.6 })],
    insights: [
      makeInsightRecord({
        id: 'x1',
        text: 'insight one',
        status: InsightStatus.GROUNDED,
        survivedScrutiny: 0.8,
      }),
    ],
    coverageReport: makeCoverageReport({ coverage: 0.75, capturedUnionCount: 3 }),
    roundScores: [makeRoundScore({ roundNumber: 1, dimMeansA: makeDimScores({ logic: 5.0 }) })],
    resultType: ResultType.TILTED,
    complexityFlag: ComplexityFlag.NORMAL,
  });

  const sid = createSessionId();
  assert.equal(typeof sid, 'string');
  result.sessionId = sid;

  // save: serialise to a JSON-safe document (what would be written to "<unit>.json").
  const document = JSON.stringify(toJsonable(result));
  assert.ok(document.length > 0);

  // load: deserialise back into a UnitResult (revives Date fields).
  const loaded = fromJsonable<UnitResult>(JSON.parse(document));
  assert.equal(loaded.topic, 'Test topic');
  assert.ok(approxEqual(loaded.weights.composite, 0.55));
  assert.equal(loaded.ideaLedger[0].text, 'idea one');
  assert.equal(loaded.insights[0].status, InsightStatus.GROUNDED);
  assert.ok(approxEqual(loaded.roundScores[0].dimMeansA.logic, 5.0));
  assert.equal(loaded.resultType, ResultType.TILTED);

  // query: build the cross-unit summary rows and apply the result_type filter.
  const allSummaries: UnitSummary[] = [loaded].map((r) => unitResultToSummary(r));
  const query = (resultType: string): UnitSummary[] =>
    allSummaries.filter((s) => s.resultType === resultType);

  const summaries = query(ResultType.TILTED);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].unitId, result.unitId);
  assert.ok(approxEqual(summaries[0].captureCoverage, 0.75));
  // filter that excludes the row returns nothing
  assert.deepEqual(query('decisive'), []);
});

test('test_agentconfig_distinct_families', () => {
  // Python AgentConfig(model_family=...) -> TS makeAgentConfig({ modelFamily }).
  const a = makeAgentConfig({ modelFamily: 'qwen' });
  const b = makeAgentConfig({ modelFamily: 'gemma' });
  assert.notEqual(a.modelFamily, b.modelFamily);
});
