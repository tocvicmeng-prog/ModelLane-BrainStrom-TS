// acceptance.test.ts — headless VS Code RUNTIME acceptance coverage (audit finding F5).
//
// The manual companion (docs/ACCEPTANCE.md) signs off the real in-editor workflow:
// install vsix -> reload -> Configure (connector + seats, optional API key) ->
// VS Code Chat -> pick the 🧠 Brainstorm Debate Model -> type a topic -> confirm the
// plan -> watch the live board -> receive + save the Markdown report. That path needs
// a real model server, so it cannot run in CI.
//
// THIS test proves the SAME contract HEADLESSLY and with ZERO NETWORK: the
// configure -> session -> report wiring that the chat handler invokes is exactly
// EngineService.runSession(params). We construct a REAL EngineService (same constructor
// the extension uses: emit + secretsAccessor + injectable executors) and drive its
// real groupEmit()->board bridge and real secrets plumbing. The ONLY thing faked is the
// network boundary: instead of building live connectors from a base URL, we inject a
// sessionExecutor that runs the REAL orchestrator pipeline (real decompose, real
// runSession scheduler, real chiefScribe aggregate) over the deterministic mock-LLM
// fakes used by pipeline.test.ts / groupRunner.test.ts. So every layer ABOVE the socket
// is the production code path:
//
//   configure  -> SecretsAccessor returns the provisioned (in-memory) secret (S2),
//                 and the params object is the connector+role_map+domain shape the
//                 Configure UI / connectorRegistry.buildSessionParams produces.
//   session    -> svc.runSession(params) routes to the executor, which decomposes the
//                 domain into a knowledge-point DAG, schedules the debates in dependency
//                 order, and forwards every GroupEvent through the service's real
//                 emit -> board bridge (Python make_event_emitter: event/<kind>).
//   report     -> chiefScribe.aggregate renders the savable Markdown report; the result
//                 is brainstormReportToDict-shaped (markdown + groups_run), exactly what
//                 the chat handler hands back to VS Code Chat to display + save.
//
// Assertions prove the end-to-end contract: a report/markdown-shaped result returns AND
// group events were emitted (schedule.plan / group.start / group.interim /
// aggregate.progress) through the real service, proving configure->session->report. T3
// tier: deterministic, zero tokens, no HTTP, no subprocess; compiles + passes under
// strict tsc + node:test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import {
  EngineService,
  type EmitEngineEvent,
  type EngineEvent,
  type EngineServiceExecutors,
  type SecretsAccessor,
} from '../brainstorm/engineService';

import type { AgentUsage } from '../engine/agent';
import { EmbeddingsClient } from '../engine/embeddings';
import { Harvester, type Extractor } from '../engine/harvester';
import { JudgeEngine } from '../engine/judge';
import { KnowledgeEngine } from '../engine/research';
import { MoveType, makeIdeaRecord, makeMove, type IdeaRecord, type Move } from '../engine/types';

import { aggregate } from '../orchestrator/chiefScribe';
import { decompose } from '../orchestrator/decompose';
import { runGroup, makeGroupClients, type GroupClients } from '../orchestrator/groupRunner';
import { runSession, type RunOne } from '../orchestrator/scheduler';
import {
  DebateMode,
  KnowledgePointSet,
  RoleMap,
  brainstormReportToDict,
  makeBrainstormReport,
  makeGroupSpec,
  makeSeatConfig,
  type GroupEvent,
  type KnowledgePoint,
} from '../orchestrator/types';

// --------------------------------------------------------------------------- fixtures (inline)
// Byte-faithful subset of the mock LLM fixtures used by pipeline.test.ts, so the compiled
// acceptance test has NO external file deps and stays deterministic.

const JFX = {
  score_a_wins: [
    {
      rationale: 'X argues more rigorously with evidence.',
      V: { X: { logic: 9, evidence: 9, responsiveness: 9 }, Y: { logic: 3, evidence: 2, responsiveness: 3 } },
      G: { X: { novelty: 7, assumptions: 6, motion: 5 }, Y: { novelty: 4, assumptions: 3, motion: 2 } },
      violations: [],
    },
    {
      rationale: 'Y (now A) remains the stronger turn after swap.',
      V: { X: { logic: 3, evidence: 2, responsiveness: 3 }, Y: { logic: 9, evidence: 9, responsiveness: 9 } },
      G: { X: { novelty: 4, assumptions: 3, motion: 2 }, Y: { novelty: 7, assumptions: 6, motion: 5 } },
      violations: [],
    },
  ],
  monitor: { key_points: ['A proposes catalyst reuse', 'B raises a cost concern'], violations: [], converging: true, notes: 'on track' },
  study: 'Core facts: enzyme catalysis lowers activation energy. Controversies: scalability. Gaps: cost data.',
  brief: 'Governing question: What is the most viable approach to scalable catalysis?',
  synthesize: "Co-authored synthesis: combine A's transition-state mechanism with B's cost analysis.",
};

const HARVEST_TWO_ATOMIC = [
  { text: 'The catalyst lowers activation energy by stabilising the transition state', author_agent: 'A' },
  { text: 'Reusing the catalyst across batches cuts per-unit cost substantially', author_agent: 'B' },
];

const VERIFY_GROUNDED = {
  premises: [
    { premise: 'the catalyst lowers activation energy', verdict: 'support', kb_ref: 'snippet-3', attack_type: 'premise' },
    { premise: 'lower activation energy increases reaction rate', verdict: 'support', kb_ref: 'snippet-4', attack_type: 'inference' },
  ],
  connective: 'AND',
};

// The decomposition proposer/moderator output (NOT used by the debate path). The real
// decompose() asks proposers for a JSON array of points, then asks the moderator for a
// JSON array of dependency edges. We hand back two atomic points + one informs-edge so
// the produced plan is deterministic, acyclic, and validates.
const DECOMP_POINTS = JSON.stringify([
  { text: 'Local-first inference is the right default for new startups', kind: 'atomic', rationale: 'cost + privacy' },
  { text: 'Cost/benefit cross-cutting lens', kind: 'lens', rationale: 'spans the others' },
]);
const DECOMP_EDGES_EMPTY = '[]'; // ids are assigned by decompose(); empty edges => trivially acyclic.

// --------------------------------------------------------------------------- fakes (mirror _bs_fakes)

// Duck-typed debate agent — engine only calls these methods (FakeAgent).
class FakeAgent {
  readonly agentLabel: string;
  readonly modelFamily: string;
  lastUsage: AgentUsage = { prompt: 0, completion: 0 };
  injected: string[] = [];
  private readonly slipText: string;
  private readonly moveType: string;
  private readonly moveContent: string;

  constructor(label: string, family: string, slipText: string, moveType: string, moveContent: string) {
    this.agentLabel = label;
    this.modelFamily = family;
    this.slipText = slipText;
    this.moveType = moveType;
    this.moveContent = moveContent;
  }

  injectContext(knowledge: string): void {
    this.injected.push(knowledge);
  }

  async requestSlips(_prompt: string, roundNumber = 0, phase = 'propose'): Promise<IdeaRecord[]> {
    return [
      makeIdeaRecord({
        id: 'i-' + randomUUID().replace(/-/g, '').slice(0, 8),
        text: this.slipText,
        agent: this.agentLabel,
        roundNumber,
        phase,
        modelFamily: this.modelFamily,
        harvestedFrom: 'slip',
      }),
    ];
  }

  async requestMove(_prompt: string, roundNumber = 0, phase = 'clash'): Promise<Move> {
    return makeMove({
      id: 'm-' + randomUUID().replace(/-/g, '').slice(0, 8),
      agent: this.agentLabel,
      moveType: this.moveType,
      content: this.moveContent,
      roundNumber,
      phase,
    });
  }

  async speak(_conversation: unknown, _temperature?: number): Promise<string> {
    return 'Synthesis: combine the strongest mechanism with the cost analysis.';
  }
}

// Duck-typed harvester extractor returning a canned JSON payload (FakeExtractor).
class FakeExtractor {
  readonly modelFamily: string;
  private readonly payload: string;

  constructor(payload: unknown, family = 'bwm-fam') {
    this.payload = JSON.stringify(payload);
    this.modelFamily = family;
  }

  async speak(_messages: unknown, _temperature?: number): Promise<string> {
    return this.payload;
  }
}

// Offline research engine returning a fixed corpus (FakeResearch).
class FakeResearch extends KnowledgeEngine {
  override async routeSearch(_topic: string, _directives = '', _limit = 3): Promise<string> {
    return (
      '# Knowledge base\n\nCatalysis lowers activation energy.\n\n' +
      'Reaction kinetics depend on temperature.\n\nCost scales with catalyst loading.'
    );
  }
}

// A scripted decomposition speaker: returns the points JSON first, then the edges JSON.
// decompose() calls proposers for points and the moderator for edges; one instance can
// safely back both (it returns whatever the current call asks for by sequencing).
class FakeDecomposer {
  readonly modelFamily = 'decomp-fam';
  private readonly points: string;
  private readonly edges: string;
  constructor(points: string, edges: string) {
    this.points = points;
    this.edges = edges;
  }
  async speak(conversation: { content?: string }[], _temperature?: number): Promise<string> {
    // The edges prompt embeds the rendered POINTS json; the propose prompt embeds DOMAIN.
    const joined = conversation.map((m) => m.content ?? '').join('\n');
    return /dependency edge/i.test(joined) ? this.edges : this.points;
  }
}

// Mirrors _bs_fakes.make_clients(): a FRESH bundle per group (no shared state).
function makeClients(familyA = 'family-a', familyB = 'family-b'): GroupClients {
  const emb = new EmbeddingsClient({ mockVectors: {} }); // deterministic lexical vectors, no HTTP
  const a = new FakeAgent('A', familyA, 'immobilised enzyme reuse lowers cost', MoveType.CLAIM, 'I CLAIM the mechanism scales.');
  const b = new FakeAgent('B', familyB, 'continuous flow improves throughput', MoveType.REBUT, 'I REBUT: deactivation over cycles.');
  const judge = new JudgeEngine({
    mockResponses: {
      score: JFX.score_a_wins,
      monitor: JFX.monitor,
      study: JFX.study,
      brief: JFX.brief,
      synthesize: JFX.synthesize,
      tag_move: { valid: true },
      verify: VERIFY_GROUNDED,
    },
    embeddings: emb,
  });
  const harvester = new Harvester(new FakeExtractor(HARVEST_TWO_ATOMIC) as unknown as Extractor, emb);
  return makeGroupClients({
    agentA: a,
    agentB: b,
    judge,
    embeddings: emb,
    research: new FakeResearch(),
    harvester,
  });
}

// The role map a real session would carry (built by Configure / buildSessionParams). The
// connectorIds are irrelevant here because the executor injects fake clients per group.
function makeRoleMap(): RoleMap {
  return new RoleMap({
    agentA: makeSeatConfig({ seatId: 'sa', connectorId: 'local', model: 'model-a', role: 'agentA', family: 'family-a' }),
    agentB: makeSeatConfig({ seatId: 'sb', connectorId: 'local', model: 'model-b', role: 'agentB', family: 'family-b' }),
    judge: makeSeatConfig({ seatId: 'sj', connectorId: 'local', model: 'model-j', role: 'judge', family: 'judge-family' }),
  });
}

// ----------------------------------------------------------------- network-free session executor
// Drives the REAL orchestrator pipeline (decompose -> runSession scheduler -> aggregate)
// over the deterministic fakes. This is the in-process stand-in for defaultSessionExecutor:
// it has the SAME signature (params, secrets, emit) and forwards the SAME GroupEvents, but
// substitutes fake LLM clients for the live-connector build (the only network boundary).
const networkFreeSessionExecutor: EngineServiceExecutors['sessionExecutor'] = async (
  params: Record<string, any>,
  secrets: Record<string, string>,
  emit: (event: GroupEvent) => void,
): Promise<Record<string, unknown>> => {
  // configure: the provisioned secret must reach the executor (S2).
  assert.equal(secrets['local'], 'sek-in-memory', 'provisioned secret reached the session executor (S2)');

  const roleMap = makeRoleMap();
  const sessionId = params.session_id ?? 'acc-s';
  const mode = params.mode ?? DebateMode.CRITICAL;

  // session/decompose: real decompose() over a scripted proposer + moderator (no network).
  const decomposer = new FakeDecomposer(DECOMP_POINTS, DECOMP_EDGES_EMPTY);
  const pset: KnowledgePointSet = await decompose(params.domain, {
    proposers: [decomposer, decomposer],
    moderator: decomposer,
    maxPoints: params.max_points ?? 6,
    emit,
    sessionId,
  });
  // Plan must be valid + acyclic before execution (CONFIRM_PLAN invariant).
  assert.equal(pset.validate().length, 0, 'decomposed plan validates (acyclic, complete)');
  assert.ok(pset.points.length >= 1, 'decomposition produced at least one knowledge point');

  const byId = new Map<string, KnowledgePoint>(pset.points.map((p) => [p.id, p]));

  // session/execute: real scheduler runs the debates in dependency order; fresh fake
  // clients per group; the session emit is forwarded into each group (production wiring).
  const runOne: RunOne = async (pointId, prior) => {
    const spec = makeGroupSpec({
      groupId: pointId,
      point: byId.get(pointId)!,
      mode,
      roleMap,
      priorContext: prior,
      sessionId,
    });
    return runGroup(spec, makeClients(), { emit });
  };
  const results = await runSession(pset, runOne, { emit, sessionId });

  // report: real chief scribe renders the savable Markdown report.
  const report = await aggregate(params.domain, mode, pset, results, { emit, sessionId });
  return brainstormReportToDict(report);
};

// --------------------------------------------------------------------------- the params Configure builds

// The session params shape produced by the Configure UI / connectorRegistry.buildSessionParams:
// a connector catalog (kind + base_url, NO secret), a role_map of seats, and the domain. The
// secret is held in memory and supplied by the SecretsAccessor, never inlined here.
function buildSessionParams(): Record<string, any> {
  return {
    domain: 'Is local-first inference a better default than the cloud for new startups?',
    mode: DebateMode.CRITICAL,
    session_id: 'acc-s',
    max_points: 6,
    connectors: [{ id: 'local', kind: 'openai-compatible', base_url: 'http://localhost:1234/v1', allow_remote: false }],
    role_map: {
      agent_a: { seat_id: 'sa', connector_id: 'local', model: 'model-a', role: 'agentA', family: 'family-a' },
      agent_b: { seat_id: 'sb', connector_id: 'local', model: 'model-b', role: 'agentB', family: 'family-b' },
      judge: { seat_id: 'sj', connector_id: 'local', model: 'model-j', role: 'judge', family: 'judge-family' },
    },
  };
}

// --------------------------------------------------------------------------- tests

// configure -> session -> report, end to end through the REAL EngineService: a real
// report/markdown-shaped result returns AND the board received the live debate events.
test('acceptance_configure_session_report_end_to_end', async () => {
  // configure: the live-board sink + the in-memory provisioned secret (S2), exactly as
  // the extension constructs the service (emit + secretsAccessor + executors).
  const board: EngineEvent[] = [];
  const emit: EmitEngineEvent = (e) => board.push(e);
  const secretsAccessor: SecretsAccessor = () => ({ local: 'sek-in-memory' });
  const svc = new EngineService(emit, secretsAccessor, { sessionExecutor: networkFreeSessionExecutor });

  // session: the single call the VS Code Chat handler makes after the user confirms the plan.
  const result = await svc.runSession(buildSessionParams());

  // report: a brainstormReportToDict-shaped result came back (the savable Markdown artifact).
  assert.equal(typeof result['markdown'], 'string', 'a markdown report field is present');
  const markdown = result['markdown'] as string;
  assert.ok(markdown.length > 0, 'the report markdown is non-empty');
  assert.ok(markdown.startsWith('---'), 'the report carries YAML front-matter (savable to a .md file)');
  assert.equal(result['domain'], buildSessionParams().domain, 'the report echoes the requested domain');
  assert.equal(typeof result['groupsRun'], 'number', 'the report reports a groupsRun count');
  assert.ok((result['groupsRun'] as number) >= 1, 'at least one knowledge point was debated');
  // Every confirmed point is accounted for: run + failed == the two-point plan decompose() built.
  assert.equal(
    (result['groupsRun'] as number) + (result['groupsFailed'] as number),
    2,
    'every confirmed plan point produced a result (groupsRun + groupsFailed == plan size)',
  );
  assert.equal(result['groupsFailed'], 0, 'no debate failed in the deterministic run');

  // board: the live debate events streamed through the REAL service emit -> board bridge,
  // forwarded as event/<kind> EngineEvents (Python make_event_emitter parity).
  assert.ok(board.length > 0, 'the live board received events from the session');
  for (const e of board) {
    assert.ok(e.method.startsWith('event/'), `board event is forwarded as event/<kind>: ${e.method}`);
    assert.equal(typeof e.params, 'object', 'each forwarded event carries a to_dict() params payload');
  }
  const kinds = new Set(board.map((e) => e.method));
  for (const expected of ['event/schedule.plan', 'event/group.start', 'event/group.interim', 'event/aggregate.progress']) {
    assert.ok(kinds.has(expected), `expected forwarded board event ${expected}`);
  }
});

// The provisioned secret (Set API key / S2) reaches the session executor verbatim through
// the real service's SecretsAccessor — the configure step's contribution to the contract.
test('acceptance_provisioned_secret_reaches_session', async () => {
  let seen: string | undefined;
  const sniffing: EngineServiceExecutors['sessionExecutor'] = async (_params, secrets) => {
    seen = secrets['local'];
    return brainstormReportToDict(makeBrainstormReport({ domain: 'd', mode: 'critical', markdown: '---\nok\n' }));
  };
  const svc = new EngineService(
    () => {
      /* board not needed for this assertion */
    },
    () => ({ local: 'sek-in-memory' }),
    { sessionExecutor: sniffing },
  );

  await svc.runSession({ domain: 'd' });
  assert.equal(seen, 'sek-in-memory', 'the in-memory provisioned secret reached run.session (S2)');
});
