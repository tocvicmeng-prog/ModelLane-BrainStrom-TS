// chiefScribe.test.ts — STRICT-TS node:test port of python/tests/test_bs_chief_scribe.py.
//
// chief_scribe (N10) tests: dedup, topological order, uncertainty-enforcing report.
// One test() per pytest function, same assertions/intent.
//
// API mapping notes (Python -> TS):
//   * brainstrom.chief_scribe.aggregate(...) -> orchestrator/chiefScribe.aggregate(...).
//     The TS aggregate() is ASYNC (the scribe call is awaited), so these tests await it;
//     with no scribe injected it runs purely mechanically (T3 tier: no HTTP, no tokens).
//   * KnowledgePoint("id", "text", "kind") (positional) -> makeKnowledgePoint({ id, text, kind }).
//   * DependencyEdge("src", "dst", "kind") -> makeDependencyEdge({ src, dst, kind }).
//   * KnowledgePointSet(points=, edges=) -> new KnowledgePointSet(points, edges).
//   * GroupResult("pid", InterimConclusion(...)) -> makeGroupResult({ groupId, interim }).
//   * InterimConclusion("gid", "pid", "summary", validated_key_points=..., candidate_insights=...,
//     evidence_status=..., sigma_si=..., composite=..., participation=...) ->
//     makeInterimConclusion({ groupId, pointId, summary, validatedKeyPoints, candidateInsights,
//     evidenceStatus, sigmaSi, composite, participation }).
//   * rep.validated_key_points -> rep.validatedKeyPoints; rep.groups_run/groups_failed ->
//     rep.groupsRun/groupsFailed; rep.per_point -> rep.perPoint (Record<string, unknown>[]).
//   * Python `section in md` (substring) -> md.includes(section); the TS headings carry a
//     parenthetical suffix on "Per-point conclusions", so substring containment matches.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregate } from '../orchestrator/chiefScribe';
import {
  KnowledgePointSet,
  makeDependencyEdge,
  makeGroupResult,
  makeInterimConclusion,
  makeKnowledgePoint,
} from '../orchestrator/types';

test('report structure and dedup', async () => {
  const pset = new KnowledgePointSet(
    [
      makeKnowledgePoint({ id: 'p1', text: 'Solar vs nuclear', kind: 'atomic' }),
      makeKnowledgePoint({ id: 'p2', text: 'Equity lens', kind: 'lens' }),
    ],
    [makeDependencyEdge({ src: 'p1', dst: 'p2', kind: 'informs' })],
  );
  const results = [
    makeGroupResult({
      groupId: 'p1',
      interim: makeInterimConclusion({
        groupId: 'p1',
        pointId: 'p1',
        summary: 'p1 summary',
        validatedKeyPoints: ['Solar cheaper at scale'],
        candidateInsights: ['maybe transmutation solves waste'],
        evidenceStatus: 'grounded',
        sigmaSi: 2.5,
        composite: 0.7,
        participation: ['fa', 'fb'],
      }),
    }),
    makeGroupResult({
      groupId: 'p2',
      interim: makeInterimConclusion({
        groupId: 'p2',
        pointId: 'p2',
        summary: 'p2 summary',
        validatedKeyPoints: ['Solar cheaper at scale', 'Equity needs subsidy'],
        candidateInsights: [],
        evidenceStatus: 'grounded',
        participation: ['fa', 'fb'],
      }),
    }),
  ];
  const rep = await aggregate('energy', 'critical', pset, results);
  const md = rep.markdown;
  for (const section of [
    '## Executive synthesis',
    '## Decomposition map',
    '## Per-point conclusions',
    '## Cross-cutting findings',
    '## What we are NOT sure about',
    '## Provenance & metrics',
  ]) {
    assert.ok(md.includes(section), `expected section ${section}`);
  }
  // dedup across groups: "Solar cheaper at scale" appears once in cross-cutting list
  assert.equal(rep.validatedKeyPoints.filter((v) => v === 'Solar cheaper at scale').length, 1);
  assert.ok(rep.validatedKeyPoints.includes('Equity needs subsidy'));
  assert.ok(md.includes('maybe transmutation solves waste')); // candidate surfaced (LD7)
  assert.equal(rep.groupsRun, 2);
  assert.equal(rep.groupsFailed, 0);
  const ids = rep.perPoint.map((pp) => pp['id'] as string);
  assert.ok(ids.indexOf('p1') < ids.indexOf('p2')); // topological order
});

test('failed group is reported not hidden', async () => {
  const pset = new KnowledgePointSet([makeKnowledgePoint({ id: 'p1', text: 'A', kind: 'atomic' })], []);
  const results = [makeGroupResult({ groupId: 'p1', interim: null, unitResult: null, error: 'boom' })];
  const rep = await aggregate('x', 'mixed', pset, results);
  assert.equal(rep.groupsFailed, 1);
  assert.ok(rep.markdown.includes('group failed'));
  assert.ok(rep.markdown.includes('boom'));
});
