// multiDebate.test.ts — STRICT-TS node:test port of python/tests/test_bs_multi.py.
//
// Panel engine (>2 debaters in ONE group) tests. Mirrors the three pytest
// functions one-for-one: a 3-way panel credits all three families, a 4-way panel
// emits start→clash_round→interim with all four debaters reported up front, and a
// 1-debater panel is rejected (panel requires >=2). Mock LLMs, zero network.
//
// API mapping notes (Python -> TS):
//   * brainstrom.multi_debate.run_panel(spec, panel, emit=cb) -> runPanel(spec,
//     panel, { emit: cb }). PanelClients fields are camelCase (debaters / judge /
//     embeddings / harvester / research). Events carry .kind + .payload.
//   * GroupResult: .error / .interim (camelCase). InterimConclusion: .pointId /
//     .participation / .validatedKeyPoints / .candidateInsights.
//   * GroupSpec(group_id=..., point=KnowledgePoint(...), mode=..., session_id=...)
//     -> makeGroupSpec({ groupId, point: makeKnowledgePoint(...), mode, sessionId }).
//     The panel spec has no role_map (runPanel takes its debaters from PanelClients).
//   * The shared _bs_fakes (FakeAgent / FakeExtractor / FakeResearch) plus the real
//     EmbeddingsClient / JudgeEngine / Harvester (mock-fed) are rebuilt inline here,
//     matching the bsN1 test's fake-client patterns. T3 tier: zero tokens, no HTTP,
//     no subprocess.
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
  MoveType,
  makeIdeaRecord,
  makeMove,
  type IdeaRecord,
  type Move,
} from '../engine/types';
import {
  runPanel,
  type PanelClients,
  type PanelDebater,
  type PanelHarvester,
  type PanelJudge,
  type PanelResearch,
} from '../orchestrator/multiDebate';
import {
  DebateMode,
  makeGroupSpec,
  makeKnowledgePoint,
  type GroupEvent,
  type GroupSpec,
} from '../orchestrator/types';

// --------------------------------------------------------------------------- fixtures (inline)

// mock_judge_responses.json (subset consumed by the panel: study / brief /
// synthesize / score / monitor / tag_move).
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

// Duck-typed panel debater — the panel engine only calls these methods (FakeAgent).
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

// Build an N-debater PanelClients (mirror Python _panel(n)). Debater i is REBUT for
// i==0 else CLAIM, modelFamily=`fam-{i}` so participation == ["fam-0", "fam-1", ...].
function makePanel(n: number): PanelClients {
  const emb = new EmbeddingsClient({ mockVectors: {} }); // deterministic lexical vectors, no HTTP
  const debaters: FakeAgent[] = [];
  for (let i = 0; i < n; i++) {
    debaters.push(
      new FakeAgent(
        String.fromCharCode(65 + i),
        `fam-${i}`,
        `idea ${i}: immobilised catalysis lowers cost`,
        i === 0 ? MoveType.REBUT : MoveType.CLAIM,
        `move ${i}`,
      ),
    );
  }
  const judge = new JudgeEngine({
    mockResponses: {
      study: JFX.study,
      brief: JFX.brief,
      synthesize: JFX.synthesize,
      tag_move: { valid: true },
      score: JFX.score_a_wins,
      monitor: JFX.monitor,
      verify: VERIFY_GROUNDED,
    },
    embeddings: emb,
  });
  const harvester = new Harvester(new FakeExtractor(HARVEST_TWO_ATOMIC) as unknown as Extractor, emb);
  return {
    debaters: debaters as unknown as PanelDebater[],
    judge: judge as unknown as PanelJudge,
    embeddings: emb,
    harvester: harvester as unknown as PanelHarvester,
    research: new FakeResearch() as unknown as PanelResearch,
  };
}

// Panel spec — no role_map (runPanel takes debaters from PanelClients).
function makeSpec(mode: string = DebateMode.HEURISTIC): GroupSpec {
  return makeGroupSpec({
    groupId: 'g1',
    point: makeKnowledgePoint({ id: 'p1', text: 'Is X better than Y?', kind: 'atomic' }),
    mode,
    sessionId: 's',
  });
}

// --------------------------------------------------------------------------- tests

test('panel runs with three debaters', async () => {
  const res = await runPanel(makeSpec(), makePanel(3));
  assert.equal(res.error, null);
  assert.notEqual(res.interim, null);
  assert.equal(res.interim!.pointId, 'p1');
  // all 3 credited (not just 2)
  assert.deepEqual(res.interim!.participation, ['fam-0', 'fam-1', 'fam-2']);
  assert.ok(Array.isArray(res.interim!.validatedKeyPoints));
  assert.ok(Array.isArray(res.interim!.candidateInsights));
});

test('panel emits events for all debaters', async () => {
  const events: GroupEvent[] = [];
  await runPanel(makeSpec(), makePanel(4), { emit: (e) => events.push(e) });
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], 'group.start');
  assert.equal(kinds[kinds.length - 1], 'group.interim');
  assert.ok(
    events.some((e) => e.kind === 'group.phase' && (e.payload as Record<string, unknown>)['action'] === 'clash_round'),
  );
  // 4-way panel reported up front
  assert.equal((events[0]!.payload['debaters'] as unknown[]).length, 4);
});

test('panel requires at least two', async () => {
  const res = await runPanel(makeSpec(), makePanel(1));
  assert.notEqual(res.error, null);
  assert.equal(res.interim, null);
});
