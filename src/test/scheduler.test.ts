// scheduler.test.ts — STRICT-TS node:test port of python/tests/test_bs_scheduler.py.
//
// scheduler (N9): DAG -> topological waves, parallel within a layer, sequential
// across layers, quarantined predecessor context (Flaw 3), and an absolute token
// budget governor that stops scheduling. Mirrors the three pytest functions
// one-for-one; every assertion/intent is preserved.
//
// API mapping notes (Python -> TS):
//   * brainstrom.scheduler.run_session(pset, run_one, emit=cb, budget=..,
//     max_concurrency=..) -> runSession(pointSet, runOne, { emit, budget,
//     maxConcurrency }). It is async in the TS port (await).
//   * brainstrom.scheduler.BudgetGovernor(max_total_tokens=N) ->
//     new BudgetGovernor(N).
//   * GroupResult(group_id, interim, unit_result) ->
//     makeGroupResult({ groupId, interim, unitResult }); .group_id -> .groupId.
//   * InterimConclusion(group_id, point_id, summary) ->
//     makeInterimConclusion({ groupId, pointId, summary }).
//   * KnowledgePoint("p1", "A") (id, text) -> makeKnowledgePoint({ id, text }).
//   * DependencyEdge("p1", "p2", "requires") (src, dst, kind) ->
//     makeDependencyEdge({ src, dst, kind: EdgeKind.REQUIRES }).
//   * KnowledgePointSet(points=.., edges=..) -> new KnowledgePointSet(points, edges).
//   * The Python _FakeUnit(total_tokens) exposes .total_tokens; the TS scheduler
//     reads .totalTokens off unitResult, so the fake unit is { totalTokens }.
//   * GroupEvent.kind strings are byte-identical: "schedule.plan", "budget".
//   * The quarantined prior block is built by quarantinePriorClaims, whose text
//     contains "PRIOR CLAIMS" and the upstream summary (e.g. "sum-p1").
// T-tier: zero tokens, no HTTP, no subprocess.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BudgetGovernor, runSession, type RunOne } from '../orchestrator/scheduler';
import {
  EdgeKind,
  GroupEvent,
  GroupResult,
  KnowledgePointSet,
  makeDependencyEdge,
  makeGroupResult,
  makeInterimConclusion,
  makeKnowledgePoint,
} from '../orchestrator/types';

// Python _FakeUnit(total_tokens): only the totalTokens field is read by the scheduler.
function fakeUnit(totalTokens: number): { totalTokens: number } {
  return { totalTokens };
}

// Python _pset_sequential(): p1 --requires--> p2 (p1 must run before p2).
function psetSequential(): KnowledgePointSet {
  return new KnowledgePointSet(
    [makeKnowledgePoint({ id: 'p1', text: 'A' }), makeKnowledgePoint({ id: 'p2', text: 'B' })],
    [makeDependencyEdge({ src: 'p1', dst: 'p2', kind: EdgeKind.REQUIRES })],
  );
}

test('test_runs_in_dependency_order_with_quarantined_context', async () => {
  const calls: Array<[string, string]> = [];

  const runOne: RunOne = (pid, prior) => {
    calls.push([pid, prior]);
    return makeGroupResult({
      groupId: pid,
      interim: makeInterimConclusion({ groupId: pid, pointId: pid, summary: `sum-${pid}` }),
      unitResult: fakeUnit(100),
    });
  };

  const events: GroupEvent[] = [];
  const results = await runSession(psetSequential(), runOne, { emit: (e) => events.push(e) });

  // p1 before p2 (requires)
  assert.deepEqual(
    calls.map(([pid]) => pid),
    ['p1', 'p2'],
  );

  // p2's prior context is the quarantined p1 interim (Flaw 3)
  const priorForP2 = new Map(calls).get('p2')!;
  assert.ok(priorForP2.includes('sum-p1'));
  assert.ok(priorForP2.includes('PRIOR CLAIMS'));

  assert.equal(results.length, 2);
  assert.ok(events.some((e) => e.kind === 'schedule.plan'));
});

test('test_budget_governor_stops_scheduling', async () => {
  const runOne: RunOne = (pid) =>
    makeGroupResult({
      groupId: pid,
      interim: makeInterimConclusion({ groupId: pid, pointId: pid, summary: 's' }),
      unitResult: fakeUnit(1000),
    });

  const events: GroupEvent[] = [];
  // p1 charges 1000 -> exhausted before p2's layer.
  const budget = new BudgetGovernor(500);
  const results = await runSession(psetSequential(), runOne, {
    emit: (e) => events.push(e),
    budget,
  });

  assert.equal(results.length, 1); // p2 layer skipped
  assert.ok(events.some((e) => e.kind === 'budget'));
});

test('test_parallel_layer_runs_all', async () => {
  const pset = new KnowledgePointSet(
    [
      makeKnowledgePoint({ id: 'p1', text: 'A' }),
      makeKnowledgePoint({ id: 'p2', text: 'B' }),
      makeKnowledgePoint({ id: 'p3', text: 'C' }),
    ],
    [], // all independent
  );

  const runOne: RunOne = (pid) =>
    makeGroupResult({
      groupId: pid,
      interim: makeInterimConclusion({ groupId: pid, pointId: pid, summary: 's' }),
      unitResult: fakeUnit(10),
    });

  const results: GroupResult[] = await runSession(pset, runOne, { maxConcurrency: 3 });
  assert.deepEqual(new Set(results.map((r) => r.groupId)), new Set(['p1', 'p2', 'p3']));
});
