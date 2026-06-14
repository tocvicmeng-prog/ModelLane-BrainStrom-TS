// engineServiceRpc.test.ts — STRICT-TS node:test port of python/tests/test_bs_rpc.py.
//
// The Python test exercised rpc_server.py (N12): Content-Length framing round-trip,
// the Dispatcher (system.hello / unknown-method -32601 / notification-no-id),
// handler-error -> -32000 JSON-RPC error, and the blocking serve() loop.
//
// THE WIRE PROTOCOL IS GONE. Per the port's design (see engineService.ts header),
// the extension and engine now run in ONE Node process: NO framing, NO JSON-RPC
// envelope, NO serve loop, NO subprocess. The former RPC methods became direct async
// methods on EngineService, and `event/*` notifications became EngineEvents forwarded
// through an injected `emit` callback. So each pytest is ported to the in-process
// behaviour that REPLACED it — same intent, no network, fake injected executors:
//
//   * test_framing_round_trip            -> in_process_params_and_result_round_trip
//       Framing proved a request's params survived the wire and the result came back
//       intact. In-process this is the EngineService method handing `params` to the
//       injected executor verbatim and returning its result object unchanged.
//   * test_read_message_eof_returns_none -> no_emit_when_executor_emits_nothing
//       EOF -> None proved "no message, no work". In-process there is no stream/loop;
//       the analog is: if the executor emits no GroupEvent, the board sink is never
//       called (no spurious notifications) and the call still returns its result.
//   * test_dispatch_hello_and_unknown_and_notification
//                                        -> dispatch_routes_each_method_to_its_executor
//       hello-result + unknown-method-32601 + notification-no-id collapsed into the
//       in-process truth: each of the four methods routes to its OWN injected executor
//       (no registry, no "method not found", no id/notification envelope).
//   * test_dispatch_handler_error_becomes_jsonrpc_error
//                                        -> executor_error_propagates_as_rejection
//       A raising handler became a -32000 error envelope on the wire. In-process there
//       is no envelope: the executor's throw propagates as a rejected Promise, carrying
//       the original error type/message (no swallowing, no -32000 wrapper).
//   * test_serve_loop_reads_request_writes_response
//                                        -> method_call_returns_result_and_forwards_events
//       The serve loop read a request and wrote a response. In-process a single method
//       call returns the result directly AND forwards any GroupEvent the executor emits
//       to the board as an `event/${kind}` EngineEvent (Python make_event_emitter).
//
// Fakes are injected EngineServiceExecutors (the Python BrainstormService keyword
// args) so every path is unit-testable without network/subprocess/tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EngineService,
  type EmitEngineEvent,
  type EngineEvent,
  type EngineServiceExecutors,
  type SecretsAccessor,
} from '../brainstorm/engineService';
import { makeGroupEvent, type GroupEvent } from '../orchestrator/types';

// --------------------------------------------------------------------------- harness

// The injected executor signature (params, secrets, emit) -> Promise<result dict>,
// matching defaultExecutor/defaultSessionExecutor/... in engineService.ts.
type Executor = (
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: (event: GroupEvent) => void,
) => Promise<Record<string, unknown>>;

// Build an EngineService whose four paths each route to a tagged echo executor, plus
// a captured list of forwarded board events (the in-process `event/*` notifications).
function makeService(
  overrides: EngineServiceExecutors = {},
  secrets: Record<string, string> = {},
): { svc: EngineService; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const emit: EmitEngineEvent = (e) => {
    events.push(e);
  };
  const secretsAccessor: SecretsAccessor = () => secrets;
  // Each default tags its result with the path name so we can prove correct routing.
  const tagged = (name: string): Executor => async (params) => ({
    method: name,
    echoedParams: params,
  });
  const executors: EngineServiceExecutors = {
    executor: (overrides.executor ?? tagged('run.group')) as EngineServiceExecutors['executor'],
    sessionExecutor: (overrides.sessionExecutor ??
      tagged('run.session')) as EngineServiceExecutors['sessionExecutor'],
    decomposeExecutor: (overrides.decomposeExecutor ??
      tagged('run.decompose')) as EngineServiceExecutors['decomposeExecutor'],
    executeExecutor: (overrides.executeExecutor ??
      tagged('run.executePlan')) as EngineServiceExecutors['executeExecutor'],
  };
  return { svc: new EngineService(emit, secretsAccessor, executors), events };
}

// --------------------------------------------------------------------------- tests

// Was test_framing_round_trip: params in, result out, byte-for-byte intact — only now
// there is no Content-Length envelope, just the direct in-process method call.
test('in_process_params_and_result_round_trip', async () => {
  const captured: Record<string, any>[] = [];
  const echo: Executor = async (params) => {
    captured.push(params);
    return { jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } };
  };
  const { svc } = makeService({ executor: echo as EngineServiceExecutors['executor'] });

  const request = { jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } };
  const result = await svc.runGroup(request);

  // The executor received the params object unchanged (no framing / re-serialisation).
  assert.deepEqual(captured[0], request);
  // And the round-tripped result is identical to what the Python wire test asserted.
  assert.deepEqual(result, { jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } });
});

// Was test_read_message_eof_returns_none ("no message -> no work"): in-process there is
// no stream, so the analog is "executor emits nothing -> the board sink is never called",
// while the call still returns its result (no spurious notifications).
test('no_emit_when_executor_emits_nothing', async () => {
  const silent: Executor = async () => ({ ok: true });
  const { svc, events } = makeService({ executor: silent as EngineServiceExecutors['executor'] });

  const result = await svc.runGroup({});
  assert.deepEqual(result, { ok: true });
  assert.equal(events.length, 0); // no GroupEvent emitted -> no event/* forwarded
});

// Was test_dispatch_hello_and_unknown_and_notification: in-process there is no method
// registry / "method not found" / id-envelope — instead each of the four methods routes
// to its OWN injected executor and returns that executor's result directly.
test('dispatch_routes_each_method_to_its_executor', async () => {
  const { svc } = makeService();

  const g = await svc.runGroup({ group_id: 'g' });
  const s = await svc.runSession({ domain: 'd' });
  const d = await svc.decompose({ domain: 'd' });
  const e = await svc.executePlan({ points: [] });

  assert.equal(g['method'], 'run.group');
  assert.equal(s['method'], 'run.session');
  assert.equal(d['method'], 'run.decompose');
  assert.equal(e['method'], 'run.executePlan');
  // params reach the routed executor verbatim (no envelope unwrapping).
  assert.deepEqual(g['echoedParams'], { group_id: 'g' });
  assert.deepEqual(e['echoedParams'], { points: [] });
});

// Was test_dispatch_handler_error_becomes_jsonrpc_error: a raising handler used to be
// wrapped into a {-32000, "ValueError: nope"} envelope. In-process there is no wire and
// no wrapper — the throw propagates as a rejected Promise with the original message.
test('executor_error_propagates_as_rejection', async () => {
  const boom: Executor = async () => {
    throw new Error('nope');
  };
  const { svc } = makeService({ executor: boom as EngineServiceExecutors['executor'] });

  await assert.rejects(() => svc.runGroup({}), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'nope'); // original error surfaced, not a -32000 envelope
    return true;
  });
});

// Was test_serve_loop_reads_request_writes_response: one request -> one response. In-process
// a single method call returns the result directly AND forwards any GroupEvent the executor
// emits to the board as an `event/${kind}` EngineEvent (Python make_event_emitter parity).
test('method_call_returns_result_and_forwards_events', async () => {
  const emitting: Executor = async (_params, _secrets, emit) => {
    emit(makeGroupEvent({ groupId: 'g1', kind: 'group.start', payload: { x: 1 }, sessionId: 's1' }));
    return { id: 1, version: '1.0' };
  };
  const { svc, events } = makeService({ executor: emitting as EngineServiceExecutors['executor'] });

  const msg = await svc.runGroup({ jsonrpc: '2.0', id: 1, method: 'system.hello', params: {} });
  // Response came straight back (the serve-loop "write response" analog).
  assert.equal(msg['id'], 1);
  assert.ok('version' in msg);

  // The emitted GroupEvent was forwarded to the board as event/<kind> with to_dict() params.
  assert.equal(events.length, 1);
  assert.equal(events[0]!.method, 'event/group.start');
  assert.deepEqual(events[0]!.params, {
    group_id: 'g1',
    kind: 'group.start',
    payload: { x: 1 },
    session_id: 's1',
  });
});

// Bonus parity with the dispatch test's secret plumbing: secrets flow from the accessor
// into every executor (Python BrainstormService held them in memory and passed them in).
test('secrets_flow_from_accessor_into_executor', async () => {
  let seen: Record<string, string> | null = null;
  const sniff: Executor = async (_params, secrets) => {
    seen = secrets;
    return {};
  };
  const { svc } = makeService(
    { decomposeExecutor: sniff as EngineServiceExecutors['decomposeExecutor'] },
    { 'local': 'sk-in-memory' },
  );

  await svc.decompose({ domain: 'd' });
  assert.deepEqual(seen, { 'local': 'sk-in-memory' });
});
