// service.test.ts — STRICT-TS node:test port of python/tests/test_bs_service.py.
//
// The Python module tested the rpc "service" wiring: the connector factory
// (make_connector kinds + egress enforcement), clients_from_connectors building a
// guarded GroupClients bundle, and the run.group RPC path with an injected executor.
//
// THE JSON-RPC SERVER IS GONE. Per the port's design (see engineService.ts header),
// the extension and engine run in ONE Node process: NO framing, NO JSON-RPC envelope,
// NO Dispatcher/BrainstormService/build_dispatcher. So the run.group path is ported to
// the in-process EngineService.runGroup with an injected executor (the Python
// BrainstormService(executor=...) keyword arg). The other three tests target the same
// modules the Python imported, just with camelCase names:
//
//   * test_make_connector_kinds                        -> make_connector_kinds
//       make_connector("openai-compatible", ...) -> makeConnector('openai-compatible', ...);
//       isinstance checks -> instanceof. The TS factory takes (kind, connectorId,
//       baseUrl, opts) so the api_key/allow_remote kwargs move into opts.
//   * test_make_connector_enforces_egress              -> make_connector_enforces_egress
//       pytest.raises(EgressError) -> assert.throws(..., EgressError) — a remote base
//       on the (forced-local) openai-compatible connector fails fast at construction.
//   * test_clients_from_connectors_builds_guarded_bundle
//                                                      -> clients_from_connectors_builds_guarded_bundle
//       role_map seats use connector_id "local"; clientsFromConnectors builds the bundle
//       through the connector, so judge is a JudgeEngine, research is the default
//       NoopKnowledgeEngine (research off by default, S5), agent_a is NOT an
//       AnthropicAgentClient, and agent_a.endpoint is the connector's base url.
//   * test_run_group_rpc_path_with_injected_executor   -> run_group_in_process_path_with_injected_executor
//       Was: BrainstormService(emit, executor); session.provisionSecrets RPC; run.group
//       RPC; assert result point_id + emitted event kinds. In-process: EngineService
//       receives the secrets via its secretsAccessor (the in-memory provisioned secrets,
//       no provisionSecrets RPC), routes runGroup() to the injected fake executor, which
//       asserts the secret was handed in, emits two GroupEvents, and returns the dict.
//       Forwarded board events carry method `event/<kind>` (Python make_event_emitter).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentClient } from '../engine/agent';
import { JudgeEngine } from '../engine/judge';

import {
  EngineService,
  type EmitEngineEvent,
  type EngineEvent,
  type EngineServiceExecutors,
  type SecretsAccessor,
} from '../brainstorm/engineService';
import { AnthropicAgentClient, AnthropicConnector } from '../orchestrator/connectors/anthropic';
import { EgressError } from '../orchestrator/connectors/egress';
import { makeConnector } from '../orchestrator/connectors/factory';
import { OpenAICompatibleConnector } from '../orchestrator/connectors/openaiCompatible';
import { clientsFromConnectors, type ConnectorMap } from '../orchestrator/groupRunner';
import { NoopKnowledgeEngine } from '../orchestrator/security';
import { RoleMap, makeGroupEvent, makeSeatConfig, type GroupEvent } from '../orchestrator/types';

// --------------------------------------------------------------------------- helpers

// _bs_fakes.make_spec().role_map — seats all on connector_id "local" so the bundle is
// built entirely through the one OpenAICompatibleConnector below.
function makeRoleMap(): RoleMap {
  return new RoleMap({
    agentA: makeSeatConfig({ seatId: 'sa', connectorId: 'local', model: 'model-a', role: 'agentA', family: 'family-a' }),
    agentB: makeSeatConfig({ seatId: 'sb', connectorId: 'local', model: 'model-b', role: 'agentB', family: 'family-b' }),
    judge: makeSeatConfig({ seatId: 'sj', connectorId: 'local', model: 'model-j', role: 'judge', family: 'judge-family' }),
  });
}

// --------------------------------------------------------------------------- tests

// Was test_make_connector_kinds: the factory dispatches kind -> the right connector
// subclass. allow_remote=True on the anthropic case keeps the remote base legal.
test('make_connector_kinds', () => {
  assert.ok(
    makeConnector('openai-compatible', 'local', 'http://localhost:1234/v1') instanceof OpenAICompatibleConnector,
  );
  assert.ok(
    makeConnector('anthropic', 'anthropic', 'https://api.anthropic.com/v1', {
      apiKey: 'k',
      allowRemote: true,
    }) instanceof AnthropicConnector,
  );
});

// Was test_make_connector_enforces_egress: a remote base on the openai-compatible
// connector (forced local, allowRemote off) fails fast at construction with EgressError.
test('make_connector_enforces_egress', () => {
  assert.throws(
    () => makeConnector('openai-compatible', 'local', 'https://api.openai.com/v1'),
    EgressError,
  );
});

// Was test_clients_from_connectors_builds_guarded_bundle: every slot is built THROUGH
// the connector, so judge is a JudgeEngine, research defaults to NoopKnowledgeEngine
// (research off by default — S5), agent_a is the OpenAI-shaped AgentClient (NOT the
// Anthropic subclass), and its endpoint is the connector's base url.
test('clients_from_connectors_builds_guarded_bundle', () => {
  const conn = new OpenAICompatibleConnector('local', 'http://localhost:1234/v1');
  const roleMap = makeRoleMap();
  const clients = clientsFromConnectors(roleMap, { local: conn } as unknown as ConnectorMap, {
    researchEnabled: false,
  });

  assert.ok(clients.judge instanceof JudgeEngine);
  assert.ok(clients.research instanceof NoopKnowledgeEngine); // research off by default (S5)
  assert.equal(clients.agentA instanceof AnthropicAgentClient, false);
  assert.ok(clients.agentA instanceof AgentClient);
  assert.equal((clients.agentA as AgentClient).endpoint, 'http://localhost:1234/v1'); // built through the connector
});

// Was test_run_group_rpc_path_with_injected_executor: the run.group path hands the
// provisioned secrets + an emit sink to the injected executor and returns its dict.
//
// In-process mapping:
//   * BrainstormService(emit=..., executor=fake) -> new EngineService(emit, secretsAccessor, { executor: fake }).
//   * session.provisionSecrets RPC -> the secretsAccessor returns the in-memory secrets
//     {local: "sek"} (no provisionSecrets RPC; secrets are held by the host).
//   * disp.handle({method: "run.group", params}) -> svc.runGroup(params).
//   * emitted GroupEvents -> forwarded to the board as EngineEvents method=`event/<kind>`,
//     so the emitted kinds are recovered by stripping the `event/` prefix.
test('run_group_in_process_path_with_injected_executor', async () => {
  const events: EngineEvent[] = [];
  const emit: EmitEngineEvent = (e) => {
    events.push(e);
  };
  const secretsAccessor: SecretsAccessor = () => ({ local: 'sek' });

  const fakeExecutor = (async (
    params: Record<string, any>,
    secrets: Record<string, string>,
    groupEmit: (event: GroupEvent) => void,
  ): Promise<Record<string, unknown>> => {
    assert.equal(secrets['local'], 'sek'); // secret provisioned + handed to executor
    groupEmit(makeGroupEvent({ groupId: params['group_id'], kind: 'group.start', payload: {} }));
    groupEmit(makeGroupEvent({ groupId: params['group_id'], kind: 'group.interim', payload: { summary: 'done' } }));
    return { group_id: params['group_id'], point_id: params['point']['id'], summary: 'done' };
  }) as unknown as EngineServiceExecutors['executor'];

  const svc = new EngineService(emit, secretsAccessor, { executor: fakeExecutor });

  const result = await svc.runGroup({
    group_id: 'g1',
    point: { id: 'p1', text: 't', kind: 'atomic' },
    mode: 'critical',
    role_map: {},
  });

  assert.equal(result['point_id'], 'p1');
  // Forwarded board events are method=`event/<kind>`; recover the GroupEvent kinds.
  assert.deepEqual(
    events.map((e) => e.method.replace(/^event\//, '')),
    ['group.start', 'group.interim'],
  );
});
