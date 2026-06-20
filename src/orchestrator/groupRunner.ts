// groupRunner.ts (N8) — one knowledge point -> one ``UnitEngine.run()``.
//
// This is the core Unit Cell invocation seam and the place the TOTAL-egress property
// (ARCHITECTURE F4) is enforced: every one of the engine's seven client slots is
// INJECTED (agentA, agentB, judge, embeddings, research, harvester primary extractor,
// harvester second extractor), so UnitEngine.build never constructs a default
// (unguarded) client. clientsFromConnectors builds that bundle from connectors in
// production; tests build it from fakes. The trap-client test (test_total_egress)
// patches the engine's default constructors to raise and asserts a group still runs.

import { AgentClient } from '../engine/agent';
import { EmbeddingsClient } from '../engine/embeddings';
import { Harvester } from '../engine/harvester';
import { JudgeEngine } from '../engine/judge';
import { KnowledgeEngine } from '../engine/research';
import {
  RigorTier,
  makeJudgeConfig,
  makeUnitConfig,
  type AuditEvent,
  type KeyPoint,
  type UnitConfig,
  type UnitResult,
} from '../engine/types';
import { UnitEngine } from '../engine/engine';

import { httpFetch } from '../engine/http';
import { makeGuardedFetch, RESEARCH_ALLOWLIST } from './connectors/egress';
import { NoopKnowledgeEngine } from './security';
import {
  RoleMap,
  makeGroupEvent,
  makeGroupResult,
  makeInterimConclusion,
  interimConclusionToDict,
  modeProfile,
  type GroupEvent,
  type GroupResult,
  type GroupSpec,
  type InterimConclusion,
  type SeatConfig,
} from './types';

// --------------------------------------------------------------------------- types

/** Emit sink for the live board — GROUP/PHASE grain only (F8). undefined => no-op. */
export type Emit = (event: GroupEvent) => void;

/** A connector slot: builds egress-guarded agent + embeddings clients (BaseConnector satisfies it). */
export interface GroupConnector {
  makeAgentClient(args: {
    model: string;
    temperature?: number;
    systemPrompt?: string;
    modelFamily?: string;
    agentLabel?: string;
  }): AgentClient;
  makeEmbeddingsClient(args?: { model?: string; cacheDir?: string | null; expectedDim?: number | null }): EmbeddingsClient;
}

/** Connectors registry keyed by connectorId (the Python ``connectors: dict``). */
export type ConnectorMap = Record<string, GroupConnector>;

// Minimal shape of an agent client that can receive quarantined upstream context.
interface ContextInjectable {
  injectContext(knowledge: string): void;
}

// The seven injected engine slots for one group (egress-guarded in production).
export interface GroupClients {
  agentA: unknown;
  agentB: unknown;
  judge: unknown; // a JudgeEngine (already holds an injected client)
  embeddings: unknown;
  research: unknown;
  harvester: unknown;
}

export function makeGroupClients(args: GroupClients): GroupClients {
  return {
    agentA: args.agentA,
    agentB: args.agentB,
    judge: args.judge,
    embeddings: args.embeddings,
    research: args.research,
    harvester: args.harvester,
  };
}

// PanelClients shape from the (not-yet-ported) multiDebate module — declared locally
// so the lazy panel path stays compilable until that module lands. Mirrors the Python
// brainstrom.multi_debate.PanelClients dataclass.
interface PanelClients {
  debaters: unknown[];
  judge: unknown;
  embeddings: unknown;
  harvester: unknown;
  research: unknown;
}

// Lazy-import surface of brainstrom.multi_debate (mirrors Python's local imports).
interface MultiDebateModule {
  PanelClients: new (args: PanelClients) => PanelClients;
  runPanel(spec: GroupSpec, panel: PanelClients, opts?: { emit?: Emit }): Promise<GroupResult>;
}

// Defer module resolution to runtime so an unported ./multiDebate does not break the
// build (faithful to Python's function-local ``from brainstrom.multi_debate import ...``).
async function loadMultiDebate(): Promise<MultiDebateModule> {
  const spec = './multiDebate';
  return (await import(spec)) as unknown as MultiDebateModule;
}

const NOMIC_EMBED = 'nomic-embed-text';

// Build the research slot. Research is remote BY NATURE; when enabled it is routed through
// the egress guard restricted to the known research-API hosts (allowRemote, https-only,
// SSRF/metadata + DNS-rebinding blocked) so the TOTAL-egress invariant holds even for
// research (audit F1). Off => the privacy-default NoopKnowledgeEngine.
export function buildResearch(researchEnabled: boolean): unknown {
  if (!researchEnabled) {
    return new NoopKnowledgeEngine();
  }
  return new KnowledgeEngine(30, 2, 0.5, makeGuardedFetch(httpFetch, true, RESEARCH_ALLOWLIST));
}

// --------------------------------------------------------------------------- run_group

// Run one debate group and project a UnitResult into an InterimConclusion.
//
// emit (optional) receives GroupEvents for the live board (group.start /
// group.phase / group.interim / group.error) — GROUP/PHASE grain only (F8).
export async function runGroup(
  spec: GroupSpec,
  clients: GroupClients,
  opts: { emit?: Emit; rngSeed?: number } = {},
): Promise<GroupResult> {
  const emit = opts.emit;
  const rngSeed = opts.rngSeed ?? 1234;

  const prof = modeProfile(spec.mode, spec.point.kind);
  const cfg: UnitConfig = makeUnitConfig({
    topic: spec.point.text,
    maxRounds: prof.maxRounds,
    proposeClashSplit: prof.proposeClashSplit,
    objective: prof.objective,
    rigorTier: prof.rigorTier,
    generatorTemp: prof.generatorTemp,
    verifierTemp: prof.verifierTemp,
  });
  if (spec.roleMap !== null) {
    cfg.agentA.modelFamily = spec.roleMap.agentA.family;
    cfg.agentB.modelFamily = spec.roleMap.agentB.family;
    cfg.judge.modelFamily = spec.roleMap.judge.family;
  }

  // Engine phase events (AuditEvent) -> GroupEvent "group.phase" (F8 grain).
  const sink = (ev: AuditEvent | Record<string, unknown>): void => {
    if (emit !== undefined) {
      const e = ev as Partial<AuditEvent>;
      emit(
        makeGroupEvent({
          groupId: spec.groupId,
          kind: 'group.phase',
          payload: { action: e.action, phase: e.phase, description: e.description },
          sessionId: spec.sessionId,
        }),
      );
    }
  };

  const engine = new UnitEngine({
    agentA: clients.agentA as never,
    agentB: clients.agentB as never,
    judge: clients.judge as never,
    embeddings: clients.embeddings as never,
    research: clients.research as never,
    harvester: clients.harvester as never,
    onEvent: sink,
    rngSeed,
  });

  // Inject quarantined upstream context (Flaw 3) into both debaters before the run.
  if (spec.priorContext) {
    try {
      (clients.agentA as ContextInjectable).injectContext(spec.priorContext);
      (clients.agentB as ContextInjectable).injectContext(spec.priorContext);
    } catch {
      // context injection must never abort a group
    }
  }

  if (emit !== undefined) {
    emit(
      makeGroupEvent({
        groupId: spec.groupId,
        kind: 'group.start',
        payload: { point: spec.point.text, kind: spec.point.kind, mode: spec.mode },
        sessionId: spec.sessionId,
      }),
    );
  }

  let result: UnitResult;
  try {
    result = await engine.run(cfg);
  } catch (exc) {
    // engine.run guards internally; this is belt-and-suspenders.
    if (emit !== undefined) {
      emit(
        makeGroupEvent({
          groupId: spec.groupId,
          kind: 'group.error',
          payload: { error: errorName(exc) },
          sessionId: spec.sessionId,
        }),
      );
    }
    return makeGroupResult({ groupId: spec.groupId, interim: null, unitResult: null, error: errorMessage(exc) });
  }

  const interim = projectInterim(spec, result);
  if (emit !== undefined) {
    emit(
      makeGroupEvent({
        groupId: spec.groupId,
        kind: 'group.interim',
        payload: interimConclusionToDict(interim),
        sessionId: spec.sessionId,
      }),
    );
  }
  return makeGroupResult({ groupId: spec.groupId, interim, unitResult: result, error: null });
}

// Project the engine's UnitResult into a compact, honest interim conclusion.
function projectInterim(spec: GroupSpec, result: UnitResult): InterimConclusion {
  const convo = result.conversation;
  let summary =
    findLastContent(convo, (c) => c['actor'] === 'judge' && c['phase'] === 'recommend') ?? '';
  if (!summary) {
    summary = findLastContent(convo, (c) => c['actor'] === 'judge') ?? '';
  }
  const validated = (result.validatedKeyPoints ?? []).map((kp: KeyPoint) => kp.text);
  const candidates = (result.candidateInsights ?? []).map((i) =>
    typeof (i as { text?: unknown }).text === 'string' ? (i as { text: string }).text : String(i),
  );
  const sigma = result.entropy ? result.entropy.stdSelfInfo : null;
  const composite = result.weights ? result.weights.composite : null;
  let participation: string[] = [];
  if (spec.roleMap !== null) {
    participation = [spec.roleMap.agentA.family, spec.roleMap.agentB.family];
  }
  const evidence = validated.length ? 'grounded' : candidates.length ? 'candidates-only' : 'inconclusive';
  return makeInterimConclusion({
    groupId: spec.groupId,
    pointId: spec.point.id,
    summary,
    validatedKeyPoints: validated,
    candidateInsights: candidates,
    evidenceStatus: evidence,
    sigmaSi: sigma,
    composite,
    participation,
    degraded: result.entropy ? Boolean(result.entropy.degraded) : false,
  });
}

// --------------------------------------------------------------------------- clients_from_connectors

// Production path: build the seven egress-guarded slots from connectors.
//
// Every client is built through a connector (which validates egress), so no
// unguarded client ever reaches the engine. Research is the privacy-default
// NoopKnowledgeEngine unless explicitly enabled (F4/F5/S5).
export function clientsFromConnectors(
  roleMap: RoleMap,
  connectors: ConnectorMap,
  opts: {
    embeddingsConnectorId?: string | null;
    embeddingsModel?: string;
    embeddingsCacheDir?: string | null;
    researchEnabled?: boolean;
  } = {},
): GroupClients {
  const embeddingsConnectorId = opts.embeddingsConnectorId ?? null;
  const embeddingsModel = opts.embeddingsModel ?? NOMIC_EMBED;
  const embeddingsCacheDir = opts.embeddingsCacheDir ?? null;
  const researchEnabled = opts.researchEnabled ?? false;

  const ca = connectors[roleMap.agentA.connectorId]!;
  const cb = connectors[roleMap.agentB.connectorId]!;
  const cj = connectors[roleMap.judge.connectorId]!;

  const agentA = ca.makeAgentClient({
    model: roleMap.agentA.model,
    temperature: roleMap.agentA.temperature,
    systemPrompt: roleMap.agentA.persona,
    modelFamily: roleMap.agentA.family,
    agentLabel: 'A',
  });
  const agentB = cb.makeAgentClient({
    model: roleMap.agentB.model,
    temperature: roleMap.agentB.temperature,
    systemPrompt: roleMap.agentB.persona,
    modelFamily: roleMap.agentB.family,
    agentLabel: 'B',
  });
  const judgeClient = cj.makeAgentClient({
    model: roleMap.judge.model,
    temperature: roleMap.judge.temperature,
    systemPrompt: roleMap.judge.persona,
    modelFamily: roleMap.judge.family,
    agentLabel: 'J',
  });

  const embConn = embeddingsConnectorId ? connectors[embeddingsConnectorId]! : cj;
  const emb = embConn.makeEmbeddingsClient({ model: embeddingsModel, cacheDir: embeddingsCacheDir });

  const judge = new JudgeEngine({
    config: makeJudgeConfig({
      model: roleMap.judge.model,
      modelFamily: roleMap.judge.family,
      rigorTier: RigorTier.STANDARD,
    }),
    client: judgeClient,
    embeddings: emb,
  });
  // Harvester extractors are connector-built too (duck-typed .speak/.modelFamily):
  // primary = judge client, second = agentB client (matches the engine's default mapping
  // intent, but always explicitly injected — never the engine default; F14).
  const harvester = new Harvester(judgeClient, emb, agentB);
  const research: unknown = buildResearch(researchEnabled);

  return makeGroupClients({
    agentA,
    agentB,
    judge,
    embeddings: emb,
    research,
    harvester,
  });
}

// --------------------------------------------------------------------------- build_panel_clients

// Build the egress-guarded components for an N-debater panel (>2 seats).
export async function buildPanelClients(
  roleMap: RoleMap,
  connectors: ConnectorMap,
  opts: {
    researchEnabled?: boolean;
    embeddingsConnectorId?: string | null;
    embeddingsModel?: string;
    embeddingsCacheDir?: string | null;
  } = {},
): Promise<PanelClients> {
  const researchEnabled = opts.researchEnabled ?? false;
  const embeddingsConnectorId = opts.embeddingsConnectorId ?? null;
  const embeddingsModel = opts.embeddingsModel ?? NOMIC_EMBED;
  const embeddingsCacheDir = opts.embeddingsCacheDir ?? null;

  const md = await loadMultiDebate();

  const seats: SeatConfig[] = roleMap.debaterSeats();
  const debaters = seats.map((s, i) =>
    connectors[s.connectorId]!.makeAgentClient({
      model: s.model,
      temperature: s.temperature,
      systemPrompt: s.persona,
      modelFamily: s.family,
      agentLabel: String.fromCharCode('A'.charCodeAt(0) + i),
    }),
  );
  const cj = connectors[roleMap.judge.connectorId]!;
  const judgeClient = cj.makeAgentClient({
    model: roleMap.judge.model,
    temperature: roleMap.judge.temperature,
    systemPrompt: roleMap.judge.persona,
    modelFamily: roleMap.judge.family,
    agentLabel: 'J',
  });
  const embConn = embeddingsConnectorId ? connectors[embeddingsConnectorId]! : cj;
  const emb = embConn.makeEmbeddingsClient({ model: embeddingsModel, cacheDir: embeddingsCacheDir });
  const judge = new JudgeEngine({
    config: makeJudgeConfig({
      model: roleMap.judge.model,
      modelFamily: roleMap.judge.family,
      rigorTier: RigorTier.STANDARD,
    }),
    client: judgeClient,
    embeddings: emb,
  });
  const harvester = new Harvester(judgeClient, emb, debaters[debaters.length - 1] ?? null);
  const research: unknown = buildResearch(researchEnabled);
  return new md.PanelClients({ debaters, judge, embeddings: emb, harvester, research });
}

// --------------------------------------------------------------------------- run_point

// Route a knowledge point to the right engine: >2 debater seats → panel
// (multiDebate), otherwise the two-agent Unit Cell engine.
export async function runPoint(
  spec: GroupSpec,
  connectors: ConnectorMap,
  opts: { emit?: Emit; researchEnabled?: boolean; embeddingsCacheDir?: string | null } = {},
): Promise<GroupResult> {
  const emit = opts.emit;
  const researchEnabled = opts.researchEnabled ?? false;
  const embeddingsCacheDir = opts.embeddingsCacheDir ?? null;

  const seats: SeatConfig[] = spec.roleMap ? spec.roleMap.debaterSeats() : [];
  if (spec.roleMap !== null && seats.length > 2) {
    const md = await loadMultiDebate();
    const panel = await buildPanelClients(spec.roleMap, connectors, { researchEnabled, embeddingsCacheDir });
    return md.runPanel(spec, panel, { emit });
  }
  const clients = clientsFromConnectors(spec.roleMap as RoleMap, connectors, { researchEnabled, embeddingsCacheDir });
  return runGroup(spec, clients, { emit });
}

// --------------------------------------------------------------------------- helpers

function findLastContent(
  convo: Record<string, unknown>[],
  pred: (c: Record<string, unknown>) => boolean,
): string | null {
  for (let i = convo.length - 1; i >= 0; i--) {
    const c = convo[i]!;
    if (pred(c)) {
      const content = c['content'];
      return typeof content === 'string' ? content : String(content ?? '');
    }
  }
  return null;
}

function errorName(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.name || 'Error';
  }
  return 'Error';
}

function errorMessage(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}
