// engineService.ts — in-process port of brainstrom/rpc_server.py.
//
// The Python sidecar spoke JSON-RPC 2.0 over Content-Length-framed stdio. Here the
// extension and the engine run in ONE Node process, so there is NO framing, NO
// subprocess, and NO JSON-RPC envelope: the former RPC methods become direct async
// methods on EngineService. Event notifications (Python's `event/*`) are forwarded
// to the live board through an injected `emit` callback as plain EngineEvents.
//
// Behaviour is preserved faithfully from rpc_server.py: same param shapes (snake_case
// keys, matching connectorRegistry's buildSessionParams / buildExecuteParams), same
// helper logic (_build_connectors / _role_map / _pset_from_params / _decompose_impl /
// _execute_impl), and the same egress allow_remote plumbing.

import { aggregate } from '../orchestrator/chiefScribe';
import type { ConnectorInterface } from '../orchestrator/connectors/base';
import { makeConnector } from '../orchestrator/connectors/factory';
import { decompose } from '../orchestrator/decompose';
import { runGroup, clientsFromConnectors, runPoint } from '../orchestrator/groupRunner';
import { BudgetGovernor, runSession } from '../orchestrator/scheduler';
import {
  GroupSpec,
  KnowledgePointSet,
  RoleMap,
  brainstormReportToDict,
  groupEventToDict,
  interimConclusionToDict,
  makeDependencyEdge,
  makeGroupSpec,
  makeKnowledgePoint,
  makeSeatConfig,
  type DependencyEdge,
  type GroupEvent,
  type KnowledgePoint,
  type SeatConfig,
} from '../orchestrator/types';

// ---------------------------------------------------------------------------- types

// Replaces the old SidecarEvent: a plain method/params notification forwarded to the
// live board. Mirrors Python `make_event_emitter`'s `{"method": f"event/{kind}",
// "params": event.to_dict()}` (the jsonrpc envelope is dropped — no wire protocol).
export interface EngineEvent {
  method: string;
  params: any;
}

// Forwards an EngineEvent to the live board (the extension wires it to the webview).
export type EmitEngineEvent = (event: EngineEvent) => void;

// In-memory secrets accessor: connectorId -> api key (Python's `secrets: dict`).
export type SecretsAccessor = () => Record<string, string>;

// The injected GroupEvent sink handed to every orchestrator function. Bridges a
// GroupEvent to an EngineEvent (the live-board forward), mirroring the Python emitter.
type GroupEmit = (event: GroupEvent) => void;

// ---------------------------------------------------------------------------- shared helpers

// _seat — build a SeatConfig from a plain param dict (snake_case keys).
function seat(d: Record<string, any>): SeatConfig {
  return makeSeatConfig({
    seatId: d.seat_id ?? d.role ?? 'seat',
    connectorId: d.connector_id,
    model: d.model,
    role: d.role ?? 'agentA',
    persona: d.persona ?? '',
    temperature: d.temperature ?? 0.7,
    family: d.family ?? 'unknown',
  });
}

// _build_connectors — build connectors from the param list; `extra` fields (CLI
// command, etc.) pass through. allow_remote is the per-connector egress plumbing.
function buildConnectors(
  params: Record<string, any>,
  secrets: Record<string, string>,
): Record<string, ConnectorInterface> {
  const connectors: Record<string, ConnectorInterface> = {};
  for (const c of (params.connectors as Record<string, any>[]) ?? []) {
    const extra: Record<string, any> = {};
    for (const [k, v] of Object.entries(c)) {
      if (k !== 'id' && k !== 'kind' && k !== 'base_url' && k !== 'allow_remote') {
        extra[k] = v;
      }
    }
    connectors[c.id] = makeConnector(c.kind ?? 'openai-compatible', c.id, c.base_url ?? '', {
      apiKey: secrets[c.id] ?? null,
      allowRemote: c.allow_remote ?? false,
      // CLI `**extra` passthrough (snake_case → camelCase for the TS factory).
      command: extra.command,
      promptVia: extra.prompt_via,
      cwd: extra.cwd,
      timeout: extra.timeout,
      maxOutputChars: extra.max_output_chars,
      envPassthrough: extra.env_passthrough,
      allowFileTools: extra.allow_file_tools,
    });
  }
  return connectors;
}

// _role_map — build a RoleMap from params.role_map (snake_case seat keys).
function roleMapFromParams(params: Record<string, any>): RoleMap {
  const rm = params.role_map as Record<string, any>;
  const debaters = ((rm.debaters as Record<string, any>[]) ?? []).map(seat);
  return new RoleMap({
    agentA: seat(rm.agent_a),
    agentB: seat(rm.agent_b),
    judge: seat(rm.judge),
    debaters: debaters.length > 0 ? debaters : null,
  });
}

// _pset_from_params — rebuild a KnowledgePointSet from an approved plan's points + edges.
function psetFromParams(params: Record<string, any>): KnowledgePointSet {
  const points: KnowledgePoint[] = ((params.points as Record<string, any>[]) ?? []).map((p) =>
    makeKnowledgePoint({
      id: p.id,
      text: p.text,
      kind: p.kind ?? 'atomic',
      rationale: p.rationale ?? '',
    }),
  );
  const edges: DependencyEdge[] = ((params.edges as Record<string, any>[]) ?? []).map((e) =>
    makeDependencyEdge({ src: e.src, dst: e.dst, kind: e.kind ?? 'informs' }),
  );
  return new KnowledgePointSet(points, edges);
}

// _decompose_impl — domain → points + dependency DAG (NO debates). Returns the pset
// plus the live connectors/role map so execute can reuse them.
async function decomposeImpl(
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: GroupEmit,
): Promise<{
  pset: KnowledgePointSet;
  connectors: Record<string, ConnectorInterface>;
  roleMap: RoleMap;
}> {
  const connectors = buildConnectors(params, secrets);
  const roleMap = roleMapFromParams(params);
  const ca = connectors[roleMap.agentA.connectorId]!;
  const cb = connectors[roleMap.agentB.connectorId]!;
  const cj = connectors[roleMap.judge.connectorId]!;
  const moderator = cj.makeAgentClient({
    model: roleMap.judge.model,
    modelFamily: roleMap.judge.family,
    agentLabel: 'MOD',
  });
  const proposers = [
    ca.makeAgentClient({ model: roleMap.agentA.model, modelFamily: roleMap.agentA.family, agentLabel: 'PA' }),
    cb.makeAgentClient({ model: roleMap.agentB.model, modelFamily: roleMap.agentB.family, agentLabel: 'PB' }),
  ];
  const pset = await decompose(params.domain, {
    proposers,
    moderator,
    maxPoints: params.max_points ?? 6,
    emit,
    sessionId: params.session_id ?? '',
  });
  return { pset, connectors, roleMap };
}

// _execute_impl — run debates for a decomposed plan; aggregate into a report dict.
async function executeImpl(
  params: Record<string, any>,
  _secrets: Record<string, string>,
  emit: GroupEmit,
  pset: KnowledgePointSet,
  connectors: Record<string, ConnectorInterface>,
  roleMap: RoleMap,
): Promise<Record<string, unknown>> {
  const domain = params.domain;
  const mode = params.mode ?? 'mixed';
  const sessionId = params.session_id ?? '';
  const researchEnabled = params.research_enabled ?? false;
  const embeddingsCacheDir = params.embeddings_cache_dir ?? null;
  const byId = new Map<string, KnowledgePoint>(pset.points.map((p) => [p.id, p]));

  // Routes to the N-debater panel engine when the role map has >2 debater seats.
  const runOne = (pointId: string, prior: string) => {
    const spec: GroupSpec = makeGroupSpec({
      groupId: pointId,
      point: byId.get(pointId)!,
      mode,
      roleMap,
      priorContext: prior,
      sessionId,
    });
    return runPoint(spec, connectors as Record<string, any>, { emit, researchEnabled, embeddingsCacheDir });
  };

  const budget = new BudgetGovernor(params.max_total_tokens ?? null);
  const results = await runSession(pset, runOne, {
    emit,
    sessionId,
    maxConcurrency: params.max_concurrency ?? 4,
    budget,
  });
  const cj = connectors[roleMap.judge.connectorId]!;
  const scribe = cj.makeAgentClient({
    model: roleMap.judge.model,
    modelFamily: roleMap.judge.family,
    agentLabel: 'SCRIBE',
  });
  const report = await aggregate(domain, mode, pset, results, { scribe, emit, sessionId });
  return brainstormReportToDict(report);
}

// ---------------------------------------------------------------------------- default executors

// run.group — build guarded clients, run ONE group, return its interim.
async function defaultExecutor(
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: GroupEmit,
): Promise<Record<string, unknown>> {
  const connectors = buildConnectors(params, secrets);
  const roleMap = roleMapFromParams(params);
  const clients = clientsFromConnectors(roleMap, connectors as Record<string, any>, {
    researchEnabled: params.research_enabled ?? false,
    embeddingsCacheDir: params.embeddings_cache_dir ?? null,
  });
  const p = params.point as Record<string, any>;
  const spec: GroupSpec = makeGroupSpec({
    groupId: params.group_id,
    point: makeKnowledgePoint({ id: p.id, text: p.text, kind: p.kind ?? 'atomic' }),
    mode: params.mode ?? 'mixed',
    roleMap,
    sessionId: params.session_id ?? '',
  });
  const result = await runGroup(spec, clients, { emit });
  if (result.error) {
    return { group_id: result.groupId, error: result.error };
  }
  return interimConclusionToDict(result.interim!);
}

// run.decompose — domain → points + dependency DAG (NO debates). TS holds the plan.
async function defaultDecomposeExecutor(
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: GroupEmit,
): Promise<Record<string, unknown>> {
  const { pset } = await decomposeImpl(params, secrets, emit);
  return {
    points: pset.points.map((p) => ({ id: p.id, text: p.text, kind: p.kind, rationale: p.rationale })),
    edges: pset.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind })),
    problems: pset.validate(),
  };
}

// run.executePlan — run debates for an already-decomposed, user-approved plan.
async function defaultExecuteExecutor(
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: GroupEmit,
): Promise<Record<string, unknown>> {
  const pset = psetFromParams(params);
  const problems = pset.validate();
  if (problems.length > 0) {
    return { error: 'plan invalid', problems };
  }
  const connectors = buildConnectors(params, secrets);
  const roleMap = roleMapFromParams(params);
  return executeImpl(params, secrets, emit, pset, connectors, roleMap);
}

// run.session — decompose + execute in ONE call (single-turn path).
async function defaultSessionExecutor(
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: GroupEmit,
): Promise<Record<string, unknown>> {
  const { pset, connectors, roleMap } = await decomposeImpl(params, secrets, emit);
  const problems = pset.validate();
  if (problems.length > 0) {
    return {
      error: 'decomposition invalid',
      problems,
      points: pset.points.map((p) => p.text),
    };
  }
  return executeImpl(params, secrets, emit, pset, connectors, roleMap);
}

// ---------------------------------------------------------------------------- service

// Injectable executors (the Python BrainstormService keyword args) so each path is
// unit-testable without network.
export interface EngineServiceExecutors {
  executor?: typeof defaultExecutor;
  sessionExecutor?: typeof defaultSessionExecutor;
  decomposeExecutor?: typeof defaultDecomposeExecutor;
  executeExecutor?: typeof defaultExecuteExecutor;
}

// In-process replacement for BrainstormService + serve(): exposes the former RPC
// methods as direct async calls. The `emit` callback forwards GroupEvents to the live
// board; `secretsAccessor` returns the in-memory provisioned secrets (S2).
export class EngineService {
  private readonly emit: EmitEngineEvent;
  private readonly secretsAccessor: SecretsAccessor;
  private readonly executor: typeof defaultExecutor;
  private readonly sessionExecutor: typeof defaultSessionExecutor;
  private readonly decomposeExecutor: typeof defaultDecomposeExecutor;
  private readonly executeExecutor: typeof defaultExecuteExecutor;

  constructor(emit: EmitEngineEvent, secretsAccessor: SecretsAccessor, executors: EngineServiceExecutors = {}) {
    this.emit = emit;
    this.secretsAccessor = secretsAccessor;
    this.executor = executors.executor ?? defaultExecutor;
    this.sessionExecutor = executors.sessionExecutor ?? defaultSessionExecutor;
    this.decomposeExecutor = executors.decomposeExecutor ?? defaultDecomposeExecutor;
    this.executeExecutor = executors.executeExecutor ?? defaultExecuteExecutor;
  }

  // GroupEvent sink handed to the orchestrator; bridges to an EngineEvent for the
  // board (mirrors Python make_event_emitter: method=`event/${kind}`, params=to_dict()).
  private groupEmit(): GroupEmit {
    return (event: GroupEvent): void => {
      this.emit({ method: `event/${event.kind}`, params: groupEventToDict(event) });
    };
  }

  // run.group — build guarded clients, run ONE group, return its interim.
  async runGroup(params: Record<string, any>): Promise<Record<string, unknown>> {
    return this.executor(params, this.secretsAccessor(), this.groupEmit());
  }

  // run.session — decompose + execute in ONE call (single-turn path).
  async runSession(params: Record<string, any>): Promise<Record<string, unknown>> {
    return this.sessionExecutor(params, this.secretsAccessor(), this.groupEmit());
  }

  // run.decompose — domain → points + dependency DAG (NO debates).
  async decompose(params: Record<string, any>): Promise<Record<string, unknown>> {
    return this.decomposeExecutor(params, this.secretsAccessor(), this.groupEmit());
  }

  // run.executePlan — run debates for an already-decomposed, user-approved plan.
  async executePlan(params: Record<string, any>): Promise<Record<string, unknown>> {
    return this.executeExecutor(params, this.secretsAccessor(), this.groupEmit());
  }
}

// Exported for downstream wiring/tests (the in-process default executor set).
export {
  buildConnectors,
  roleMapFromParams,
  psetFromParams,
  decomposeImpl,
  executeImpl,
  defaultExecutor,
  defaultSessionExecutor,
  defaultDecomposeExecutor,
  defaultExecuteExecutor,
};
