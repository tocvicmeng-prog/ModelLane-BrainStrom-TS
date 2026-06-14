// sessionService.test.ts — STRICT-TS node:test port of python/tests/test_bs_session_rpc.py.
//
// The Python test (N12) exercised the run.session JSON-RPC wiring: a BrainstormService
// built with an injected `session_executor`, a `build_dispatcher`, then two dispatched
// calls — `session.provisionSecrets` (stash an in-memory secret) followed by
// `run.session` (dispatch to the injected executor). It proved three things:
//   1. run.session routes to the injected session executor,
//   2. params (`domain`) reach that executor verbatim,
//   3. the secret provisioned earlier reaches the executor (CONSTITUTION S2),
//   4. the executor's result object comes back intact (groups_run / markdown).
//
// THE WIRE PROTOCOL IS GONE (see engineService.ts header): no JSON-RPC envelope, no
// Dispatcher, no `session.provisionSecrets` method. In-process the former RPC method
// is `EngineService.runSession`, the injected `session_executor` becomes the
// `sessionExecutor` of EngineServiceExecutors, and the provisioned secret is supplied
// by the in-memory `SecretsAccessor` the service was constructed with. The pytest is
// ported one-for-one to that in-process truth — same intent, no network/subprocess/tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EngineService,
  type EmitEngineEvent,
  type EngineServiceExecutors,
  type SecretsAccessor,
} from '../brainstorm/engineService';
import type { GroupEvent } from '../orchestrator/types';

// The injected session-executor signature (params, secrets, emit) -> Promise<result dict>,
// matching defaultSessionExecutor in engineService.ts.
type Executor = (
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: (event: GroupEvent) => void,
) => Promise<Record<string, unknown>>;

// Was test_run_session_dispatch_with_injected_executor: provision a secret, then dispatch
// run.session to an injected executor; prove the domain param and the provisioned secret
// both reach the executor and that its result returns intact.
test('run_session_dispatch_with_injected_executor', async () => {
  const captured: { domain?: string; secret?: string } = {};

  // fake_session(params, secrets, emit) — records what it was handed, returns a report dict.
  const fakeSession: Executor = async (params, secrets) => {
    captured.domain = params.domain;
    captured.secret = secrets['local']; // secrets.get("local")
    return { domain: params.domain, markdown: '# report', groups_run: 2 };
  };

  // Python: BrainstormService(emit=lambda e: None, session_executor=fake_session) plus
  // session.provisionSecrets({"local": "sek"}). In-process the provisioned secret is the
  // in-memory SecretsAccessor handed to the service at construction (S2).
  const emit: EmitEngineEvent = () => {
    /* emit=lambda e: None */
  };
  const secretsAccessor: SecretsAccessor = () => ({ local: 'sek' });
  const executors: EngineServiceExecutors = {
    sessionExecutor: fakeSession as EngineServiceExecutors['sessionExecutor'],
  };
  const svc = new EngineService(emit, secretsAccessor, executors);

  // disp.handle(run.session, {"domain": "energy futures"}) -> svc.runSession(params).
  const r = await svc.runSession({ domain: 'energy futures' });

  assert.equal(r['groups_run'], 2);
  assert.equal(r['markdown'], '# report');
  assert.equal(captured.domain, 'energy futures');
  assert.equal(captured.secret, 'sek'); // provisioned secret reaches the executor (S2)
});
