// groupRunner.test.ts — STRICT-TS node:test port of python/tests/test_bs_group_runner.py.
//
// group_runner (N8): one knowledge point -> one UnitEngine.run() -> interim.
// Mirrors the three pytest functions one-for-one; every assertion/intent is preserved.
//
// API mapping notes (Python -> TS):
//   * brainstrom.group_runner.run_group(spec, clients, emit=cb) -> runGroup(spec,
//     clients, { emit: cb }). It is async in the TS port (await).
//   * GroupResult.error / .interim / .unit_result -> .error / .interim / .unitResult.
//   * InterimConclusion.point_id / .participation -> .pointId / .participation.
//   * GroupEvent.kind / .payload (camelCase fields, byte-identical kind strings).
//   * isinstance(res.unit_result, UnitResult): UnitResult is an interface in the TS
//     port, so we assert a non-null object carrying a UnitResult field (.unitId) —
//     same intent (the engine produced a real result, not None).
//   * The "group.interim" event payload comes from interimConclusionToDict (a {...c}
//     spread), so its key is the camelCase ``pointId`` (Python's payload["point_id"]).
//   * brainstrom.types.mode_profile(mode, point_kind=...) -> modeProfile(mode, kind).
//     RigorTier.HIGH_STAKES / propose_clash_split tuple / objective label preserved.
//   * The shared _bs_fakes (FakeAgent / FakeExtractor / FakeResearch / JudgeEngine
//     mock_responses / EmbeddingsClient mock_vectors) are rebuilt inline here as
//     duck-typed fakes; the engine only calls the methods exercised below. T3 tier:
//     zero tokens, no HTTP, no subprocess.
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
import {
  RigorTier,
  MoveType,
  makeIdeaRecord,
  makeMove,
  type IdeaRecord,
  type Move,
} from '../engine/types';
import { runGroup, makeGroupClients, type GroupClients } from '../orchestrator/groupRunner';
import {
  DebateMode,
  PointKind,
  RoleMap,
  modeProfile,
  makeGroupSpec,
  makeKnowledgePoint,
  makeSeatConfig,
  type GroupEvent,
  type GroupSpec,
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

function makeSpec(mode: string = DebateMode.CRITICAL, groupId = 'g1'): GroupSpec {
  const rm = new RoleMap({
    agentA: makeSeatConfig({ seatId: 'sa', connectorId: 'local', model: 'model-a', role: 'agentA', family: 'family-a' }),
    agentB: makeSeatConfig({ seatId: 'sb', connectorId: 'local', model: 'model-b', role: 'agentB', family: 'family-b' }),
    judge: makeSeatConfig({ seatId: 'sj', connectorId: 'local', model: 'model-j', role: 'judge', family: 'judge-family' }),
  });
  return makeGroupSpec({
    groupId,
    point: makeKnowledgePoint({ id: 'p1', text: 'Is X better than Y?' }),
    mode,
    roleMap: rm,
    sessionId: 'sess1',
  });
}

// --------------------------------------------------------------------------- tests

test('run_group_returns_interim', async () => {
  const res = await runGroup(makeSpec(), makeClients());
  assert.equal(res.error, null);
  assert.notEqual(res.interim, null);
  assert.equal(res.interim!.pointId, 'p1');
  // isinstance(res.unit_result, UnitResult): UnitResult is a TS interface, so assert
  // a real (non-null) result object carrying a UnitResult field — same intent.
  assert.notEqual(res.unitResult, null);
  assert.equal(typeof (res.unitResult as { unitId?: unknown }).unitId, 'string');
  assert.deepEqual(res.interim!.participation, ['family-a', 'family-b']); // F9 participation reporting
});

test('run_group_emits_group_events', async () => {
  const events: GroupEvent[] = [];
  await runGroup(makeSpec(), makeClients(), { emit: (e) => events.push(e) });
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], 'group.start');
  assert.ok(kinds.includes('group.phase'));
  assert.equal(kinds[kinds.length - 1], 'group.interim');
  const interimEvt = events[events.length - 1]!;
  // payload from interimConclusionToDict ({...c} spread) -> camelCase pointId.
  assert.equal(interimEvt.payload['pointId'], 'p1');
});

test('mode_profile_presets', () => {
  assert.equal(modeProfile('game-theoretic').rigorTier, RigorTier.HIGH_STAKES);
  assert.deepEqual(modeProfile('critical').proposeClashSplit, [0.4, 0.6]);
  assert.ok(modeProfile('heuristic').objective.startsWith('sigma_si'));
  // MIXED routes by point kind (Flaw 2): lens -> heuristic, atomic -> critical.
  assert.ok(modeProfile('mixed', PointKind.LENS).objective.startsWith('sigma_si'));
  assert.equal(modeProfile('mixed', PointKind.ATOMIC).objective, 'assumptions-overturned');
});
