// planService.test.ts — STRICT-TS node:test port of python/tests/test_bs_plan_rpc.py.
//
// The Python test exercised the CONFIRM_PLAN two-call split over rpc_server.py's
// JSON-RPC dispatcher: `run.decompose` (turn 1, no debates) followed by
// `run.executePlan` (turn 2, the approved plan the client carried back).
//
// THE WIRE PROTOCOL IS GONE. Per the port's design (see engineService.ts header),
// the extension and engine run in ONE Node process: NO Content-Length framing, NO
// JSON-RPC envelope, NO build_dispatcher / disp.handle. The former RPC methods became
// direct async methods on EngineService (decompose / executePlan), and the
// BrainstormService keyword executors became injectable EngineServiceExecutors. So each
// pytest is ported to the in-process behaviour that REPLACED it — same intent, no
// network, fake injected executors:
//
//   * test_decompose_then_execute_dispatch -> decompose_then_execute_dispatch
//       Two disp.handle() calls (run.decompose then run.executePlan with the carried-back
//       plan) become two awaited EngineService method calls. The fake executors capture
//       params verbatim, proving the approved plan's points/edges flow turn-1 -> turn-2.
//   * test_execute_rejects_invalid_plan    -> execute_rejects_invalid_plan
//       The DEFAULT execute executor validates the plan; a <2-point plan trips the
//       decomposition floor. In-process this is the real defaultExecuteExecutor returning
//       {error: 'plan invalid', problems:[... 'at least 2' ...]} before any connector is
//       built (so no network/subprocess/tokens).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EngineService,
  defaultExecuteExecutor,
  type EmitEngineEvent,
  type EngineServiceExecutors,
  type SecretsAccessor,
} from '../brainstorm/engineService';

// --------------------------------------------------------------------------- tests

// Was test_decompose_then_execute_dispatch: turn 1 decompose (no debates), turn 2 execute
// the approved plan the client carried back. The two disp.handle() JSON-RPC calls become
// two awaited EngineService method calls; the fakes capture params so we can prove the
// points/edges produced in turn 1 flow into turn 2 intact (the CONFIRM_PLAN split).
test('decompose_then_execute_dispatch', async () => {
  const seen: Record<string, any> = {};

  // Fake decompose executor — mirrors Python fake_decompose: records the domain, returns
  // a fixed 2-point / 1-edge plan with no problems (the approvable decomposition).
  const fakeDecompose: EngineServiceExecutors['decomposeExecutor'] = async (params) => {
    seen['domain'] = params.domain;
    return {
      points: [
        { id: 'p1', text: 'A?', kind: 'atomic' },
        { id: 'p2', text: 'B lens', kind: 'lens' },
      ],
      edges: [{ src: 'p1', dst: 'p2', kind: 'requires' }],
      problems: [],
    };
  };

  // Fake execute executor — mirrors Python fake_execute: records the carried-back points
  // and edges, returns a stub report whose groups_run == number of points executed.
  const fakeExecute: EngineServiceExecutors['executeExecutor'] = async (params) => {
    seen['points'] = params.points;
    seen['edges'] = params.edges;
    return { markdown: '# report', groups_run: (params.points as unknown[]).length };
  };

  const emit: EmitEngineEvent = () => {
    /* Python emit=lambda e: None — board sink discards events. */
  };
  const secretsAccessor: SecretsAccessor = () => ({});
  const svc = new EngineService(emit, secretsAccessor, {
    decomposeExecutor: fakeDecompose,
    executeExecutor: fakeExecute,
  });

  // Turn 1 — decompose only (no debates). (Python: disp.handle run.decompose.)
  const r1 = await svc.decompose({ domain: 'energy' });
  assert.deepEqual(r1['problems'], []);
  assert.deepEqual((r1['points'] as Array<{ id: string }>).map((p) => p.id), ['p1', 'p2']);

  // Turn 2 — execute the (approved) plan the client carried back.
  // (Python: disp.handle run.executePlan with r1's points + edges.)
  const r2 = await svc.executePlan({
    domain: 'energy',
    points: r1['points'],
    edges: r1['edges'],
  });
  assert.equal(r2['groups_run'], 2);
  assert.equal(seen['domain'], 'energy');
  assert.deepEqual((seen['points'] as Array<{ id: string }>).map((p) => p.id), ['p1', 'p2']);
  assert.equal((seen['edges'] as Array<{ kind: string }>)[0]!.kind, 'requires');
});

// Was test_execute_rejects_invalid_plan: the DEFAULT execute executor validates the plan
// before running anything; a single-point plan trips the decomposition floor ("need at
// least 2 knowledge points"). In-process we use the real defaultExecuteExecutor (no
// injection), which returns {error:'plan invalid', problems:[...]} before any connector is
// built — so no network/subprocess/tokens, exactly like the Python default path.
test('execute_rejects_invalid_plan', async () => {
  const emit: EmitEngineEvent = () => {
    /* Python emit=lambda e: None. */
  };
  const secretsAccessor: SecretsAccessor = () => ({});
  // No executor overrides -> the service uses defaultExecuteExecutor (the validating path).
  const svc = new EngineService(emit, secretsAccessor);

  const r = await svc.executePlan({
    domain: 'x',
    points: [{ id: 'p1', text: 'only one' }],
    edges: [],
    role_map: {},
    connectors: [],
  });

  assert.equal(r['error'], 'plan invalid');
  const problems = r['problems'] as string[];
  assert.ok(problems.some((p) => p.includes('at least 2')));

  // Parity guard: the same default executor called directly (the exported impl helper)
  // produces the identical rejection — confirming EngineService just routes to it.
  const direct = await defaultExecuteExecutor(
    { domain: 'x', points: [{ id: 'p1', text: 'only one' }], edges: [] },
    {},
    () => {},
  );
  assert.equal(direct['error'], 'plan invalid');
  assert.ok((direct['problems'] as string[]).some((p) => p.includes('at least 2')));
});
