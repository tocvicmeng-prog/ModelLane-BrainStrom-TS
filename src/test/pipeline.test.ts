// pipeline.test.ts — STRICT-TS node:test port of python/tests/test_bs_pipeline.py.
//
// End-to-end pipeline (M2): domain DAG -> scheduled real debates -> aggregated report.
// Uses the mock LLM fakes, so it exercises the WHOLE pipeline headlessly: the real
// UnitEngine runs in each group (runGroup), the scheduler (runSession) enforces the
// dependency order and passes quarantined context, and the chief scribe (aggregate)
// renders the final report. Mirrors the single pytest function one-for-one; every
// assertion/intent is preserved.
//
// API mapping notes (Python -> TS):
//   * brainstrom.group_runner.run_group(spec, clients, emit=cb) ->
//     runGroup(spec, clients, { emit }) (async in the TS port).
//   * brainstrom.scheduler.run_session(pset, run_one, emit=cb, session_id="s") ->
//     runSession(pset, runOne, { emit, sessionId: 's' }) (async).
//   * brainstrom.chief_scribe.aggregate(domain, mode, pset, results, emit=cb) ->
//     aggregate(domain, mode, pset, results, { emit }) (async, scribe-free => mechanical).
//   * tests._bs_fakes.make_clients/make_spec -> rebuilt inline here as the shared
//     duck-typed fakes (same construction path as groupRunner.test.ts): FakeAgent /
//     FakeExtractor / FakeResearch + JudgeEngine(mockResponses) + EmbeddingsClient
//     (mockVectors). T3 tier: zero tokens, no HTTP, no subprocess.
//   * make_spec().role_map -> makeRoleMap() (only the RoleMap is needed; the Python
//     test pulls .role_map off a throwaway spec). RoleMap is its own class in TS.
//   * KnowledgePoint("p1", "Is X better than Y?", "atomic") (id, text, kind positional)
//     -> makeKnowledgePoint({ id, text, kind }).
//   * DependencyEdge("p1", "p2", "requires") -> makeDependencyEdge({ src, dst,
//     kind: EdgeKind.REQUIRES }) — p2 runs AFTER p1 and receives its context (Flaw 3).
//   * KnowledgePointSet(points=, edges=) -> new KnowledgePointSet(points, edges).
//   * GroupSpec(group_id=, point=, mode="critical", role_map=, prior_context=prior,
//     session_id="s") -> makeGroupSpec({ groupId, point, mode, roleMap, priorContext,
//     sessionId }). The scheduler's runOne(pointId, prior) forwards `prior` into the
//     spec.priorContext, mirroring the production executor.
//   * GroupResult.error / .interim -> .error / .interim (camelCase fields).
//   * report.groups_run / .markdown -> report.groupsRun / .markdown.
//   * GroupEvent.kind strings are byte-identical: "schedule.plan", "group.start",
//     "group.interim", "aggregate.progress".
//   * Fixtures (mock_judge_responses / mock_harvest / mock_verification) are embedded
//     inline (byte-faithful copies) so the compiled test has no external file deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import type { AgentUsage } from '../engine/agent';
import { EmbeddingsClient } from '../engine/embeddings';
import { Harvester, type Extractor } from '../engine/harvester';
import { JudgeEngine } from '../engine/judge';
import { KnowledgeEngine } from '../engine/research';
import { MoveType, makeIdeaRecord, makeMove, type IdeaRecord, type Move } from '../engine/types';

import { aggregate } from '../orchestrator/chiefScribe';
import { runGroup, makeGroupClients, type GroupClients } from '../orchestrator/groupRunner';
import { runSession, type RunOne } from '../orchestrator/scheduler';
import {
  DebateMode,
  EdgeKind,
  KnowledgePointSet,
  RoleMap,
  makeDependencyEdge,
  makeGroupSpec,
  makeKnowledgePoint,
  makeSeatConfig,
  type GroupEvent,
  type GroupResult,
} from '../orchestrator/types';

// --------------------------------------------------------------------------- fixtures (inline)

// mock_judge_responses.json (subset used by make_clients)
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

// mock_harvest.json -> "two_atomic"
const HARVEST_TWO_ATOMIC = [
  { text: 'The catalyst lowers activation energy by stabilising the transition state', author_agent: 'A' },
  { text: 'Reusing the catalyst across batches cuts per-unit cost substantially', author_agent: 'B' },
];

// mock_verification.json -> "grounded"
const VERIFY_GROUNDED = {
  premises: [
    { premise: 'the catalyst lowers activation energy', verdict: 'support', kb_ref: 'snippet-3', attack_type: 'premise' },
    { premise: 'lower activation energy increases reaction rate', verdict: 'support', kb_ref: 'snippet-4', attack_type: 'inference' },
  ],
  connective: 'AND',
};

// --------------------------------------------------------------------------- fakes (mirror _bs_fakes)

// Duck-typed debate agent — the engine only calls these methods (FakeAgent).
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

// Mirrors _bs_fakes.make_spec().role_map: the RoleMap the per-group spec carries.
function makeRoleMap(): RoleMap {
  return new RoleMap({
    agentA: makeSeatConfig({ seatId: 'sa', connectorId: 'local', model: 'model-a', role: 'agentA', family: 'family-a' }),
    agentB: makeSeatConfig({ seatId: 'sb', connectorId: 'local', model: 'model-b', role: 'agentB', family: 'family-b' }),
    judge: makeSeatConfig({ seatId: 'sj', connectorId: 'local', model: 'model-j', role: 'judge', family: 'judge-family' }),
  });
}

// --------------------------------------------------------------------------- tests

test('test_domain_to_report_end_to_end', async () => {
  // p2 runs after p1, gets its context (requires edge, Flaw 3).
  const pset = new KnowledgePointSet(
    [
      makeKnowledgePoint({ id: 'p1', text: 'Is X better than Y?', kind: 'atomic' }),
      makeKnowledgePoint({ id: 'p2', text: 'Cost/benefit cross-cutting lens', kind: 'lens' }),
    ],
    [makeDependencyEdge({ src: 'p1', dst: 'p2', kind: EdgeKind.REQUIRES })],
  );
  const byId = new Map(pset.points.map((p) => [p.id, p]));
  const roleMap = makeRoleMap();

  const events: GroupEvent[] = [];

  const runOne: RunOne = async (pointId, prior) => {
    const spec = makeGroupSpec({
      groupId: pointId,
      point: byId.get(pointId)!,
      mode: DebateMode.CRITICAL,
      roleMap,
      priorContext: prior,
      sessionId: 's',
    });
    // forward the session emit into the group (mirrors the production executor);
    // fresh clients per group.
    return runGroup(spec, makeClients(), { emit: (e) => events.push(e) });
  };

  const results = await runSession(pset, runOne, { emit: (e) => events.push(e), sessionId: 's' });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.error === null && r.interim !== null));

  const report = await aggregate('Is X better than Y?', 'critical', pset, results, {
    emit: (e) => events.push(e),
  });
  assert.equal(report.groupsRun, 2);
  assert.ok(report.markdown.includes('p1') && report.markdown.includes('p2'));
  assert.ok(report.markdown.startsWith('---')); // YAML front-matter (savable)

  const kinds = new Set(events.map((e) => e.kind));
  for (const expected of ['schedule.plan', 'group.start', 'group.interim', 'aggregate.progress']) {
    assert.ok(kinds.has(expected), `expected event kind ${expected}`);
  }
});
