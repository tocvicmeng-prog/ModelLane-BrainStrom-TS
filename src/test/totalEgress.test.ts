// totalEgress.test.ts — STRICT-TS node:test port of python/tests/test_bs_total_egress.py.
//
// F4 total-egress proof (trap-client test).
//
// Python intent: ``UnitEngine.build`` constructs a DEFAULT (unguarded) client for any
// slot that is NOT injected. The pytest patches every default constructor *as referenced
// inside unit.engine* (AgentClient / JudgeEngine / EmbeddingsClient / KnowledgeEngine /
// Harvester) to raise, then asserts:
//   * with NO injection, running the engine hits a trap (proving the trap is real);
//   * with FULL injection via group_runner, no trap ever fires (proving the engine
//     never builds a default client — the connector/egress guard is TOTAL).
//
// TS realization of the trap (ESM/CommonJS bindings can't be monkeypatched the way
// Python rebinds module-level names): an *unguarded* default client is, by definition,
// one whose ONLY behaviour is to reach the real network. So the trap is the network
// egress boundary itself — ``globalThis.fetch``, which every engine default routes
// through (AgentClient.speak/chat, EmbeddingsClient.embed, default KnowledgeEngine
// search all call httpFetch -> globalThis.fetch). The trap throws on ANY fetch:
//   * Negative control: the engine's default slots, built exactly as UnitEngine.build
//     does (loopback-default AgentClient/EmbeddingsClient + remote-search default
//     KnowledgeEngine), all egress -> trip the trap (the trap is real and total).
//   * Full injection: runGroup(makeSpec(), makeClients()) injects all six GroupClients
//     slots with zero-network fakes -> the trap NEVER fires, and a valid interim is
//     still produced (res.error === null, res.interim !== null).
//
// API mapping notes (Python -> TS):
//   * unit.engine constructors -> ../engine/{agent,embeddings,research,judge,harvester}.
//   * brainstrom.group_runner.run_group(spec, clients) -> runGroup(spec, clients) from
//     ../orchestrator/groupRunner (returns GroupResult: .error / .interim, camelCase).
//   * The shared _bs_fakes (FakeAgent / FakeExtractor / FakeResearch / JudgeEngine
//     mock_responses / EmbeddingsClient mock_vectors) + make_clients / make_spec are
//     rebuilt inline here (byte-faithful), exactly as bsN1.test.ts mirrors them. T3
//     tier: zero tokens, no HTTP, no subprocess.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { AgentClient, type AgentUsage } from '../engine/agent';
import { EmbeddingsClient } from '../engine/embeddings';
import { Harvester, type Extractor } from '../engine/harvester';
import { JudgeEngine } from '../engine/judge';
import { KnowledgeEngine } from '../engine/research';
import { makeUnitConfig } from '../engine/types';
import {
  MoveType,
  makeIdeaRecord,
  makeMove,
  type IdeaRecord,
  type Move,
} from '../engine/types';
import { runGroup, makeGroupClients, type GroupClients } from '../orchestrator/groupRunner';
import {
  DebateMode,
  RoleMap,
  makeGroupSpec,
  makeKnowledgePoint,
  makeSeatConfig,
  type GroupSpec,
} from '../orchestrator/types';

// --------------------------------------------------------------------------- the trap

// EgressTrapError — thrown by the trap fetch. Marks an UNGUARDED default client that
// crossed the network boundary (Python's AssertionError "engine constructed a DEFAULT
// client — egress bypass (F4 violation)").
class EgressTrapError extends Error {
  constructor() {
    super('engine reached the network through a DEFAULT (unguarded) client — egress bypass (F4 violation)');
    this.name = 'EgressTrapError';
  }
}

// Install a fetch trap that records every call and always throws. Returns a restore
// fn + a live counter so a test can assert the trap NEVER fired (total-egress guard).
function installFetchTrap(): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let count = 0;
  const trap = ((..._args: Parameters<typeof fetch>): never => {
    count += 1;
    throw new EgressTrapError();
  }) as unknown as typeof fetch;
  globalThis.fetch = trap;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls: () => count,
  };
}

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

// Duck-typed debate agent — the engine only calls these methods (FakeAgent). Zero
// tokens, zero network: it NEVER touches fetch (so the trap stays silent).
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

// Offline research engine returning a fixed corpus (FakeResearch) — no fetch.
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

test('test_trap_fires_without_injection', async () => {
  // Negative control: an un-injected engine WOULD build a DEFAULT (unguarded) client.
  // We construct the engine's default slots exactly as UnitEngine.build does and prove
  // each one's only behaviour is to egress -> trips the trap. This makes the trap real
  // (matching the pytest's pytest.raises(AssertionError) on an un-injected run).
  const trap = installFetchTrap();
  try {
    const cfg = makeUnitConfig({ topic: 'scalable catalysis' });

    // Default EmbeddingsClient (loopback default endpoint) — exercising it egresses.
    // (embed() crosses the network then degrades gracefully on failure, so the trap
    // fires but is swallowed into a lexical fallback: an unguarded default that DID
    // reach the wire. We assert the egress attempt + the degraded flag, not a throw.)
    const defaultEmb = new EmbeddingsClient({
      endpoint: cfg.embeddings.endpoint,
      model: cfg.embeddings.model,
      apiKey: cfg.embeddings.apiKey,
      expectedDim: cfg.embeddings.expectedDim,
      cacheDir: cfg.embeddings.cacheDir,
    });
    const before = trap.calls();
    // A unique probe guarantees a cache miss (no disk/mem hit short-circuiting the wire).
    await defaultEmb.embed(['egress-probe-' + randomUUID()]);
    assert.ok(trap.calls() > before, 'default embeddings must reach the network (trap fired)');
    assert.equal(defaultEmb.degraded, true, 'default embeddings degraded after the trapped egress');

    // Default AgentClient (loopback default endpoint) — speak() egresses and, unlike
    // embeddings, PROPAGATES (the agent has no degraded fallback). maxRetries=0 surfaces
    // the trapped egress immediately (no backoff). The rethrow wraps the trap message.
    const agentBefore = trap.calls();
    const defaultAgent = new AgentClient({
      endpoint: cfg.agentA.endpoint,
      model: cfg.agentA.model,
      apiKey: cfg.agentA.apiKey,
      modelFamily: cfg.agentA.modelFamily,
      temperature: cfg.agentA.temperature,
      maxRetries: 0,
      agentLabel: 'A',
    });
    await assert.rejects(
      () => defaultAgent.speak([{ role: 'user', content: 'probe' }]),
      /unreachable|F4 violation/,
    );
    assert.ok(trap.calls() > agentBefore, 'default agent must reach the network (trap fired)');

    // Default KnowledgeEngine (remote search APIs) — routeSearch egresses through
    // httpGet. maxRetries=0 + no-op sleep avoids real backoff; per-source failures are
    // swallowed into an "unavailable" corpus, but the wire was crossed (trap fired).
    const researchBefore = trap.calls();
    const noSleep = async (_ms: number): Promise<void> => undefined;
    const defaultResearch = new KnowledgeEngine(30, 0, 0.5, undefined, noSleep);
    await defaultResearch.routeSearch('scalable catalysis');
    assert.ok(trap.calls() > researchBefore, 'default research must reach the network (trap fired)');

    // The trap fired for every unguarded default (proving the trap is real + total).
    assert.ok(trap.calls() >= 3, `trap should have fired for each default client, fired ${trap.calls()}`);
  } finally {
    trap.restore();
  }
});

test('test_full_injection_never_builds_default', async () => {
  // All six GroupClients slots injected by run_group -> no engine default is ever
  // constructed, so the engine NEVER reaches the network: the trap stays silent and a
  // valid interim is still produced.
  const trap = installFetchTrap();
  let res;
  try {
    res = await runGroup(makeSpec(), makeClients());
  } finally {
    trap.restore();
  }
  assert.equal(trap.calls(), 0, 'full injection must never reach the network (no default client built)');
  assert.equal(res.error, null);
  assert.notEqual(res.interim, null);
});
