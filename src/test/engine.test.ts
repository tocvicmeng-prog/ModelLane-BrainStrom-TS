// engine.test.ts — STRICT-TS node:test port of python/tests/test_engine.py (N7).
//
// Full phase-machine runs on mock LLMs (T3, zero tokens, no network/subprocess).
// Mirrors the pytest one-for-one; every assertion/intent is preserved.
//
// API mapping notes (Python -> TS):
//   * UnitEngine takes an OPTIONS object:
//       new UnitEngine({ agentA, agentB, judge, embeddings, research, harvester })
//     (Python used kwargs agent_a=/agent_b=/...). rngSeed defaults to 1234 — the
//     pure helpers tested here don't depend on it, matching the seedless pytest.
//   * JudgeEngine takes an OPTIONS object: new JudgeEngine({ mockResponses, embeddings }).
//   * snake_case -> camelCase throughout (requestSlips, requestMove, injectContext,
//     lastUsage, modelFamily, roundScores, auditLog, verificationRecords, ...).
//   * Enums are plain string unions: MoveType.CLAIM === 'CLAIM', Phase.CLASH === 'clash',
//     ResultType.X / ComplexityFlag.X are already the string values.
//   * engine.dryRun() is SYNCHRONOUS in the TS port (returns ValidationReport, not a
//     Promise) — mirrors test_dry_run_makes_no_http.
//   * Fixtures (mock_judge_responses / mock_harvest / mock_verification) are embedded
//     inline as byte-faithful copies so the compiled test in out/test has no external
//     file dependency (the pytest used a _jfx()/_hfx() loader).
//   * Fakes are duck-typed (the engine only calls speak/requestSlips/requestMove/
//     injectContext + reads lastUsage); cast with `as unknown as <Type>`.
//
// OMITTED: test_run_save_persists — the Unit Cell save/load SQLite persistence layer
// is deliberately OUTSIDE this faithful port (see engine/types.ts header: "the Python
// module's save/load/query persistence lives outside this faithful port"). UnitResult
// has no .save()/.load(), so there is nothing to exercise. No behaviour is lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnitEngine, shouldStop, thueMorseOrder } from '../engine/engine';
import { AgentClient } from '../engine/agent';
import { EmbeddingsClient } from '../engine/embeddings';
import { Harvester, type Extractor } from '../engine/harvester';
import { JudgeEngine } from '../engine/judge';
import { KnowledgeEngine } from '../engine/research';
import { IdeaLedger } from '../engine/ledger';
import {
  ComplexityFlag,
  MoveType,
  Phase,
  ResultType,
  makeIdeaRecord,
  makeMove,
  makeUnitConfig,
  type ChatMessage,
  type IdeaRecord,
  type Move,
  type RoundScore,
  type UnitConfig,
  type UnitResult,
} from '../engine/types';

// ---------------------------------------------------------------------------
// Inline fixtures (byte-faithful copies of tests/fixtures/*.json)
// ---------------------------------------------------------------------------

// mock_judge_responses.json
const JFX: Record<string, unknown> = {
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
  monitor: {
    key_points: ['A proposes catalyst reuse', 'B raises a cost concern'],
    violations: [],
    converging: true,
    notes: 'on track',
  },
  study: 'Core facts: enzyme catalysis lowers activation energy. Controversies: scalability. Gaps: cost data.',
  brief: 'Governing question: What is the most viable approach to scalable catalysis?',
  synthesize: "Co-authored synthesis: combine A's transition-state mechanism with B's cost analysis.",
};

// mock_harvest.json
const HFX: Record<string, Array<{ text: string; author_agent: string }>> = {
  two_atomic: [
    { text: 'The catalyst lowers activation energy by stabilising the transition state', author_agent: 'A' },
    { text: 'Reusing the catalyst across batches cuts per-unit cost substantially', author_agent: 'B' },
  ],
};

// mock_verification.json — the "grounded" payload
const VFX_GROUNDED = {
  premises: [
    { premise: 'the catalyst lowers activation energy', verdict: 'support', kb_ref: 'snippet-3', attack_type: 'premise' },
    {
      premise: 'lower activation energy increases reaction rate',
      verdict: 'support',
      kb_ref: 'snippet-4',
      attack_type: 'inference',
    },
  ],
  connective: 'AND',
};

// ---------------------------------------------------------------------------
// Fakes (duck-typed; the engine only calls these methods / reads lastUsage)
// ---------------------------------------------------------------------------

class FakeAgent {
  agentLabel: string;
  modelFamily: string;
  slipTexts: string[];
  moveType: string;
  moveContent: string;
  lastUsage = { prompt: 0, completion: 0 };
  injected: string[] = [];
  raiseInSlips = false;

  constructor(label: string, family: string, slipTexts: string[], moveType: string, moveContent: string) {
    this.agentLabel = label;
    this.modelFamily = family;
    this.slipTexts = slipTexts;
    this.moveType = moveType;
    this.moveContent = moveContent;
  }

  injectContext(knowledge: string): void {
    this.injected.push(knowledge);
  }

  async requestSlips(_prompt: string, roundNumber = 0, phase: string = Phase.PROPOSE): Promise<IdeaRecord[]> {
    if (this.raiseInSlips) {
      throw new Error('simulated agent failure');
    }
    return this.slipTexts.map((t) =>
      makeIdeaRecord({
        id: 'i-' + Math.random().toString(16).slice(2, 10),
        text: t,
        agent: this.agentLabel,
        roundNumber,
        phase,
        modelFamily: this.modelFamily,
        harvestedFrom: 'slip',
      }),
    );
  }

  async requestMove(_prompt: string, roundNumber = 0, phase: string = Phase.CLASH): Promise<Move> {
    return makeMove({
      id: 'm-' + Math.random().toString(16).slice(2, 10),
      agent: this.agentLabel,
      moveType: this.moveType,
      content: this.moveContent,
      roundNumber,
      phase,
    });
  }

  async speak(_conversation: ChatMessage[], _temperature?: number): Promise<string> {
    return 'Synthesis bullets: combine the strongest mechanism with the cost analysis.';
  }
}

class FakeExtractor implements Extractor {
  private readonly payload: string;
  modelFamily: string;

  constructor(payload: unknown, family = 'bwm-fam') {
    this.payload = JSON.stringify(payload);
    this.modelFamily = family;
  }

  async speak(_messages: ChatMessage[], _temperature?: number): Promise<string> {
    return this.payload;
  }
}

class FakeResearch extends KnowledgeEngine {
  override async routeSearch(_topic: string, _directives = '', _limit = 3): Promise<string> {
    return (
      '# Knowledge base\n\nCatalysis lowers activation energy.\n\n' +
      'Reaction kinetics depend on temperature.\n\n' +
      'Cost scales with catalyst loading.\n\nScaling needs heat management.'
    );
  }
}

function makeEngine(
  budget = 100_000,
  slipLen = 1,
  raiseInSlips = false,
): { engine: UnitEngine; cfg: UnitConfig } {
  const emb = new EmbeddingsClient({ mockVectors: {} }); // deterministic lexical vectors, no HTTP
  const long = 'a sufficiently long idea slip about catalysis kinetics and cost to consume some tokens';
  const textsA = [slipLen > 1 ? long : 'immobilised enzyme reuse lowers cost'];
  const textsB = [slipLen > 1 ? long : 'continuous flow improves throughput'];
  const a = new FakeAgent('A', 'family-a', textsA, MoveType.CLAIM, 'I CLAIM the mechanism scales.');
  const b = new FakeAgent('B', 'family-b', textsB, MoveType.REBUT, 'I REBUT: deactivation over cycles.');
  a.raiseInSlips = raiseInSlips;

  const judge = new JudgeEngine({
    mockResponses: {
      score: JFX.score_a_wins,
      monitor: JFX.monitor,
      study: JFX.study,
      brief: JFX.brief,
      synthesize: JFX.synthesize,
      tag_move: { valid: true },
      verify: VFX_GROUNDED,
    },
    embeddings: emb,
  });
  const harvester = new Harvester(new FakeExtractor(HFX.two_atomic), emb);
  const engine = new UnitEngine({
    agentA: a as unknown as AgentClient,
    agentB: b as unknown as AgentClient,
    judge,
    embeddings: emb,
    research: new FakeResearch(),
    harvester,
  });
  const cfg = makeUnitConfig({ topic: 'scalable catalysis', tokenBudget: budget, maxRounds: 4 });
  cfg.agentA.modelFamily = 'family-a';
  cfg.agentB.modelFamily = 'family-b';
  cfg.judge.modelFamily = 'judge-family';
  return { engine, cfg };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('thue_morse_order', () => {
  assert.deepEqual(thueMorseOrder(4), ['A', 'B', 'B', 'A']); // ABBA balance
});

test('should_stop_needs_two_rounds', () => {
  // shouldStop(None, []) in Python -> ledger arg is unused when <2 rounds.
  assert.equal(shouldStop(new IdeaLedger(), [] as RoundScore[]), false);
});

// ---------------------------------------------------------------------------
// Full mock run
// ---------------------------------------------------------------------------

test('run_returns_unitresult', async () => {
  const { engine, cfg } = makeEngine();
  const result: UnitResult = await engine.run(cfg);
  // isinstance(result, UnitResult): the TS port returns a plain UnitResult object.
  assert.ok(result.unitId);
  assert.ok(result.sessionId);
});

test('run_includes_conversation_and_scores', async () => {
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  assert.ok(result.conversation.length > 0);
  assert.ok(result.roundScores.length > 0);
  assert.ok(result.conversation.some((c) => c['actor'] === 'judge')); // brief + synthesis
});

test('run_computes_normalized_scores_in_unit', async () => {
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  const n = result.normalized;
  assert.ok(
    [n.vNormA, n.vNormB, n.validityDifferential, n.engagementV2, n.violationRate].every(
      (v) => v >= 0 && v <= 1,
    ),
  );
});

test('run_computes_weight_vector', async () => {
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  assert.ok(result.weights.composite >= 0.0 && result.weights.composite <= 1.0);
  assert.equal(result.weights.disqualified, false);
});

test('run_classifies_result', async () => {
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  assert.ok((Object.values(ResultType) as string[]).includes(result.resultType));
  assert.ok((Object.values(ComplexityFlag) as string[]).includes(result.complexityFlag));
});

test('run_includes_audit_log', async () => {
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  const actions = new Set(result.auditLog.map((e) => e.action));
  assert.ok(actions.has('session_start') && actions.has('session_end'));
  assert.ok(actions.has('brief_frozen') && actions.has('stance_assigned'));
});

// -- v2.1 / M1 sign-off requirements -----------------------------------------

test('run_harvests_clash_insights', async () => {
  // M1: CLASH insights must be captured (the closed v2.0 leak).
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  const clashInsights = result.insights.filter((i) => i.sourcePhase === Phase.CLASH);
  assert.ok(clashInsights.length > 0, 'no insight was harvested from CLASH');
});

test('run_produces_verification_record', async () => {
  // M1: at least one first-principles verification record.
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  assert.ok(result.verificationRecords.length >= 1);
  const vr = result.verificationRecords[0]!;
  assert.notEqual(vr.verifierModelFamily, 'family-a'); // verifier != author (LD8)
});

test('run_two_tier_output', async () => {
  // M1: distilled validated key-points + flagged candidate insights.
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  assert.ok(Array.isArray(result.validatedKeyPoints));
  assert.ok(Array.isArray(result.candidateInsights));
  assert.ok(result.validatedKeyPoints.length >= 1); // grounded insights distilled
  assert.notEqual(result.coverageReport, null);
});

test('run_nonempty_ledger', async () => {
  const { engine, cfg } = makeEngine();
  const result = await engine.run(cfg);
  assert.ok(result.ideaLedger.length > 0);
});

// -- budget behaviour --------------------------------------------------------

test('budget_exhaustion_terminates', async () => {
  const { engine, cfg } = makeEngine(80, 2);
  const result = await engine.run(cfg);
  assert.ok(result.roundCount <= 2); // broke out early
  assert.ok(result.conversation.some((c) => String(c['content']).includes('terminated')));
});

test('75pc_and_95pc_injection', async () => {
  const { engine, cfg } = makeEngine(80, 2);
  const result = await engine.run(cfg);
  const contents = result.conversation.map((c) => String(c['content'])).join(' ');
  assert.ok(contents.includes('75%')); // converge message injected
  assert.ok(contents.includes('95%')); // final-statement message injected
});

// -- robustness --------------------------------------------------------------

test('error_in_phase_does_not_lose_data', async () => {
  const { engine, cfg } = makeEngine(100_000, 1, true);
  const result = await engine.run(cfg);
  // still returns a valid result
  assert.ok(result.unitId);
  assert.ok(result.auditLog.some((e) => e.action === 'error'));
  assert.ok(result.auditLog.some((e) => e.action === 'session_end')); // CLOSE always runs
});

test('dry_run_makes_no_http', () => {
  const { engine, cfg } = makeEngine();
  const report = engine.dryRun(cfg);
  assert.equal(report.configOk, true);
  assert.equal(report.embeddingsEndpointOk, true);
});
