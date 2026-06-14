// bsN1.test.ts — STRICT-TS node:test port of python/tests/test_bs_n1.py.
//
// N1 additive-surface tests: round-plan presets (the propose/clash split over
// max_rounds) + the on_event progress hook that run_group threads into
// UnitEngine. Mirrors the four pytest functions one-for-one.
//
// API mapping notes (Python -> TS):
//   * unit.engine.UnitEngine._round_plan(cfg) -> UnitEngine#roundPlan (private; the
//     pytest calls the underscore method directly, so we reach it via a typed cast).
//   * UnitConfig(max_rounds=..., propose_clash_split=...) -> makeUnitConfig({ maxRounds,
//     proposeClashSplit }). proposeClashSplit is a [number, number] | null tuple.
//   * brainstrom.group_runner.run_group(spec, clients, emit=cb) -> runGroup(spec,
//     clients, { emit: cb }). Events carry .kind + .payload (payload.action holds the
//     engine AuditEvent action for "group.phase" events).
//   * GroupResult: .error / .interim (camelCase, same semantics).
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
import { UnitEngine } from '../engine/engine';
import {
  MoveType,
  makeIdeaRecord,
  makeMove,
  makeUnitConfig,
  type IdeaRecord,
  type Move,
  type UnitConfig,
} from '../engine/types';
import { runGroup, makeGroupClients, type GroupClients } from '../orchestrator/groupRunner';
import {
  DebateMode,
  RoleMap,
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

// roundPlan is private on UnitEngine; the pytest reaches _round_plan directly, so
// expose it through a typed structural view (no behavior change, runtime-identical).
type RoundPlanFn = { roundPlan(cfg: UnitConfig): [number, number, number] };
function roundPlan(eng: UnitEngine, cfg: UnitConfig): [number, number, number] {
  return (eng as unknown as RoundPlanFn).roundPlan(cfg);
}

// --------------------------------------------------------------------------- tests

test('round_plan default reproduces upstream', () => {
  const eng = new UnitEngine();
  assert.deepEqual(roundPlan(eng, makeUnitConfig({ maxRounds: 8 })), [4, 4, 4]);
  // max_rounds=1 must match the original offset of R//2 == 0 (byte-identical default).
  assert.deepEqual(roundPlan(eng, makeUnitConfig({ maxRounds: 1 })), [1, 1, 0]);
});

test('round_plan honors split', () => {
  const eng = new UnitEngine();
  const cfg = makeUnitConfig({ maxRounds: 8, proposeClashSplit: [0.65, 0.35] });
  const [pr, cr, offset] = roundPlan(eng, cfg);
  // round(8*0.65)=5 propose, 3 clash, offset=5
  assert.deepEqual([pr, cr, offset], [5, 3, 5]);
});

test('on_event emits phase progress', async () => {
  const events: GroupEvent[] = [];
  await runGroup(makeSpec(), makeClients(), { emit: (e) => events.push(e) });
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['group.start', 'group.phase', 'group.interim']) {
    assert.ok(kinds.has(k), `expected event kind ${k}`);
  }
  const actions = new Set(
    events.filter((e) => e.kind === 'group.phase').map((e) => e.payload['action'] as string | undefined),
  );
  assert.ok(actions.has('session_start')); // logged before the try — always fires
  assert.ok(actions.has('session_end')); // CLOSE always runs
});

test('default none on_event is noop', async () => {
  // No emit sink => no error, still returns a valid interim (golden behavior).
  const res = await runGroup(makeSpec(), makeClients());
  assert.equal(res.error, null);
  assert.notEqual(res.interim, null);
});
