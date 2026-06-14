// engine.ts (N7) — Phase-machine orchestration (OPEN→PROPOSE→CLASH→RECOMMEND→CLOSE).
//
// Wires every node into one run. Generative work (brief, snippets, synthesis) and
// evaluative work (scoring, monitoring, verification) stay separated in the Judge (P5).
// The dual working models are realised here as ROLES (no new agents): BWM = the agents
// generating + the harvester capturing; DWM = the opposing agent + verifyInsight
// (verifier family ≠ author, LD8).
//
// Robustness: every phase is wrapped so an exception never discards already-generated
// data — CLOSE always assembles a valid (possibly partial) UnitResult. Budget is the
// hard ceiling; phase envelopes force transitions; σ_SI stays the primary objective.
//
// See ARCHITECTURE.md §3 (data flow) and CONSTITUTION.md §5 (phase machine).

import { randomUUID } from 'node:crypto';

import { AgentClient } from './agent';
import { BudgetTracker } from './budget';
import { hasBlockingErrors, validateConfig } from './config';
import { EmbeddingsClient } from './embeddings';
import { Harvester } from './harvester';
import {
  JudgeEngine,
  buildAttackGraph,
  computeComposite,
  groundedExtension,
  normalizeV2,
} from './judge';
import { IdeaLedger } from './ledger';
import {
  computeEntropyMetrics,
  coverageReport,
  fixationCheck,
  openingDiversity,
  openingDiversityBelowFloor,
} from './metrics';
import { makeRng, type Rng } from './rng';
import { KnowledgeEngine } from './research';
import {
  DEFAULT_NOVELTY_FLOOR,
  DEFAULT_SIGMA_HI,
  VERIFIED_STATUSES,
  InsightStatus,
  MoveType,
  Phase,
  RigorTier,
  classifyResult,
  createSessionId,
  dimScoresGenerativityTotal,
  makeAuditEvent,
  makeKeyPoint,
  makeReliabilityStats,
  makeUnitResult,
  makeValidationReport,
  makeViolation,
  KeyPointTier,
  type AuditEvent,
  type InsightRecord,
  type Move,
  type RoundScore,
  type UnitConfig,
  type UnitResult,
  type ValidationReport,
} from './types';

export const CONVERGE_MESSAGE = '[SYSTEM] Budget at 75% — begin converging toward your strongest position.';
export const FINAL_MESSAGE = '[SYSTEM] Budget at 95% — make your final statement now.';
export const FORCE_END_MESSAGE = '[SYSTEM] Budget exhausted — debate terminated.';

// ---------------------------------------------------------------------------
// Pure ordering / stopping helpers
// ---------------------------------------------------------------------------

// ABBA-balanced opening order: opener of round k = parity of popcount(k).
export function thueMorseOrder(n: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < Math.max(0, n); k++) {
    out.push(popcount(k) % 2 === 0 ? 'A' : 'B');
  }
  return out;
}

function popcount(k: number): number {
  let n = k >>> 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

export function randomizeStances(rng: Rng): Record<string, string> {
  const sides = ['position_1', 'position_2'];
  rng.shuffle(sides);
  return { A: sides[0]!, B: sides[1]! };
}

// Novel-idea rate below floor for 2 rounds AND score-stable for 2 rounds (P11).
export function shouldStop(
  ledger: IdeaLedger,
  roundScores: RoundScore[],
  noveltyFloor: number = DEFAULT_NOVELTY_FLOOR,
): boolean {
  if (roundScores.length < 2) {
    return false;
  }
  const last2 = roundScores.slice(-2);
  const nov = last2.map((r) => ledger.noveltyRate(r.roundNumber));

  const totalNorm = (r: RoundScore): number => (r.validityTotalA + r.validityTotalB) / 60.0;

  const stable = Math.abs(totalNorm(last2[1]!) - totalNorm(last2[0]!)) <= 0.05;
  return nov.every((n) => n < noveltyFloor) && stable;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

interface RunState {
  cfg: UnitConfig;
  agentA: AgentClient;
  agentB: AgentClient;
  judge: JudgeEngine;
  embeddings: EmbeddingsClient;
  ledger: IdeaLedger;
  harvester: Harvester;
  research: KnowledgeEngine;
  budget: BudgetTracker;
  result: UnitResult;
  rng: Rng;
  brief: string;
  order: string[];
  stance: Record<string, string>;
  snippetPool: string[];
  moves: Move[];
  roundNo: number;
  converged: boolean;
}

export interface UnitEngineOptions {
  agentA?: AgentClient | null;
  agentB?: AgentClient | null;
  judge?: JudgeEngine | null;
  embeddings?: EmbeddingsClient | null;
  research?: KnowledgeEngine | null;
  harvester?: Harvester | null;
  rngSeed?: number;
  // N1 additive surface: optional progress sink. undefined => no-op (golden behavior).
  onEvent?: ((e: AuditEvent | Record<string, unknown>) => void) | null;
}

export class UnitEngine {
  private readonly _agentA: AgentClient | null;
  private readonly _agentB: AgentClient | null;
  private readonly _judge: JudgeEngine | null;
  private readonly _embeddings: EmbeddingsClient | null;
  private readonly _research: KnowledgeEngine | null;
  private readonly _harvester: Harvester | null;
  private readonly _rngSeed: number;
  private readonly _onEvent: ((e: AuditEvent | Record<string, unknown>) => void) | null;

  constructor(opts: UnitEngineOptions = {}) {
    this._agentA = opts.agentA ?? null;
    this._agentB = opts.agentB ?? null;
    this._judge = opts.judge ?? null;
    this._embeddings = opts.embeddings ?? null;
    this._research = opts.research ?? null;
    this._harvester = opts.harvester ?? null;
    this._rngSeed = opts.rngSeed ?? 1234;
    this._onEvent = opts.onEvent ?? null;
  }

  // -- component wiring -------------------------------------------------
  private build(cfg: UnitConfig): RunState {
    const emb =
      this._embeddings ??
      new EmbeddingsClient({
        endpoint: cfg.embeddings.endpoint,
        model: cfg.embeddings.model,
        apiKey: cfg.embeddings.apiKey,
        expectedDim: cfg.embeddings.expectedDim,
        cacheDir: cfg.embeddings.cacheDir,
      });
    const agentA =
      this._agentA ??
      new AgentClient({
        endpoint: cfg.agentA.endpoint,
        model: cfg.agentA.model,
        apiKey: cfg.agentA.apiKey,
        systemPrompt: cfg.agentA.systemPrompt,
        modelFamily: cfg.agentA.modelFamily,
        temperature: cfg.agentA.temperature,
        timeout: cfg.agentTimeout,
        maxRetries: cfg.agentMaxRetries,
        agentLabel: 'A',
      });
    const agentB =
      this._agentB ??
      new AgentClient({
        endpoint: cfg.agentB.endpoint,
        model: cfg.agentB.model,
        apiKey: cfg.agentB.apiKey,
        systemPrompt: cfg.agentB.systemPrompt,
        modelFamily: cfg.agentB.modelFamily,
        temperature: cfg.agentB.temperature,
        timeout: cfg.agentTimeout,
        maxRetries: cfg.agentMaxRetries,
        agentLabel: 'B',
      });
    const judge = this._judge ?? new JudgeEngine({ config: cfg.judge, embeddings: emb });
    const research = this._research ?? new KnowledgeEngine();
    const harvester =
      this._harvester ??
      new Harvester(
        new AgentClient({
          endpoint: cfg.judge.endpoint,
          model: cfg.judge.model,
          apiKey: cfg.judge.apiKey,
          modelFamily: cfg.judge.modelFamily,
          temperature: cfg.verifierTemp,
          agentLabel: 'H',
        }),
        emb,
        new AgentClient({
          endpoint: cfg.agentB.endpoint,
          model: cfg.agentB.model,
          modelFamily: cfg.agentB.modelFamily,
          agentLabel: 'H2',
        }),
      );
    const ledger = new IdeaLedger(emb);
    const sid = cfg.sessionId || createSessionId();
    const result = makeUnitResult({
      unitId: 'unit-' + randomUUID().replace(/-/g, '').slice(0, 12),
      sessionId: sid,
      topic: cfg.topic,
      agentAName: cfg.agentA.name,
      agentBName: cfg.agentB.name,
      judgeModel: cfg.judge.model,
      rigorTier: tierValue(cfg.rigorTier),
      config: {
        topic: cfg.topic,
        rigor_tier: tierValue(cfg.rigorTier),
        token_budget: cfg.tokenBudget,
        max_rounds: cfg.maxRounds,
      },
    });
    return {
      cfg,
      agentA,
      agentB,
      judge,
      embeddings: emb,
      ledger,
      harvester,
      research,
      budget: new BudgetTracker(cfg.tokenBudget),
      result,
      rng: makeRng(this._rngSeed),
      brief: '',
      order: [],
      stance: {},
      snippetPool: [],
      moves: [],
      roundNo: 0,
      converged: false,
    };
  }

  // -- public entry points ---------------------------------------------
  async run(config: UnitConfig): Promise<UnitResult> {
    const st = this.build(config);
    this.log(st, 'session_start', Phase.CONFIG, `topic=${config.topic}`);
    try {
      await this.prep(st);
      await this.open(st);
      await this.propose(st);
      await this.clash(st);
      await this.recommend(st);
    } catch (exc) {
      // never lose generated data
      this.log(st, 'error', st.result.resultType, `${errorName(exc)}: ${errorMessage(exc)}`);
    }
    await this.close(st);
    return st.result;
  }

  dryRun(config: UnitConfig): ValidationReport {
    const findings = validateConfig(config);
    return makeValidationReport({
      configOk: !hasBlockingErrors(findings),
      endpointAOk: Boolean(config.agentA.endpoint),
      endpointBOk: Boolean(config.agentB.endpoint),
      judgeEndpointOk: Boolean(config.judge.endpoint),
      embeddingsEndpointOk: Boolean(config.embeddings.endpoint),
      errors: findings.filter((f) => f.severity === 'error').map((f) => f.message),
    });
  }

  // -- phases -----------------------------------------------------------
  private async prep(st: RunState): Promise<void> {
    const cfg = st.cfg;
    const corpus = await st.research.routeSearch(cfg.topic, cfg.searchDirectives);
    const notes = await st.judge.study(corpus);
    const packet = st.research.splitPackets(corpus, cfg.overlapRatio);
    st.snippetPool = st.research.chunkCorpus(corpus);
    st.agentA.injectContext(packet.forA);
    st.agentB.injectContext(packet.forB);
    this.log(st, 'knowledge_injection', Phase.INJECT, 'packets injected (asymmetric)');
    st.result.config['study_notes_len'] = notes.length;
  }

  private async open(st: RunState): Promise<void> {
    const studyNotesLen = st.result.config['study_notes_len'];
    st.brief = await st.judge.generateBrief(
      st.cfg.topic,
      studyNotesLen === undefined ? '' : String(studyNotesLen),
    );
    this.log(st, 'brief_frozen', Phase.OPEN, 'side-symmetric brief frozen');
    st.stance = randomizeStances(st.rng); // randomized AFTER freeze
    st.order = thueMorseOrder(st.cfg.maxRounds);
    this.log(st, 'stance_assigned', Phase.OPEN, pyDictRepr(st.stance));
    st.result.conversation.push({
      actor: 'judge',
      phase: Phase.OPEN,
      round: 0,
      content: st.brief,
    });
  }

  private async propose(st: RunState): Promise<void> {
    const [proposeRounds] = this.roundPlan(st.cfg);
    const slipPrompt =
      `Topic: ${st.cfg.topic}\n${st.brief}\nList 3 new idea slips (<=50 words each) as JSON.`;
    // Round 0: mandatory simultaneous solo drafting (committed before exchange).
    await this.slipRound(st, 0, slipPrompt);
    this.log(st, 'round0_committed', Phase.PROPOSE, 'solo drafts committed');
    st.result.openingDiversity = openingDiversity(st.ledger);
    if (openingDiversityBelowFloor(st.ledger)) {
      this.log(st, 'reseed_round', Phase.PROPOSE, 'opening diversity below floor — one re-seed');
      await this.slipRound(st, 0, slipPrompt); // ONE re-seed
    }
    for (let r = 1; r <= proposeRounds; r++) {
      if (this.budgetGuard(st, Phase.PROPOSE)) {
        break;
      }
      await this.slipRound(st, r, slipPrompt);
      fixationCheck(st.ledger, r); // telemetry
      if (shouldStop(st.ledger, st.result.roundScores)) {
        this.log(st, 'stability_stop', Phase.PROPOSE, `stopped at round ${r}`);
        break;
      }
    }
  }

  private async slipRound(st: RunState, r: number, prompt: string): Promise<void> {
    const slipsA = await st.agentA.requestSlips(prompt, r);
    const slipsB = await st.agentB.requestSlips(prompt, r);
    const textA = slipsA.map((s) => s.text).join(' ');
    const textB = slipsB.map((s) => s.text).join(' ');
    this.recordTurn(st, 'agent_a', Phase.PROPOSE, r, textA);
    this.recordTurn(st, 'agent_b', Phase.PROPOSE, r, textB);
    await st.ledger.ingest([...slipsA, ...slipsB]);
    st.ledger.dedup();
    // Harvest the full prose too (slips may bury insights in prose) — v2.1.
    await this.harvest(st, `${textA}\n${textB}`, Phase.PROPOSE, r);
    // Score (WITHHELD from agents during PROPOSE — P9) and set idea quality from generativity.
    const rs = await st.judge.scoreRound(
      textA,
      textB,
      st.cfg.scoringScale,
      tierValue(st.cfg.rigorTier),
      r,
      Phase.PROPOSE,
    );
    st.result.roundScores.push(rs);
    this.chargeJudge(st, textA + textB, Phase.PROPOSE);
    this.setIdeaQuality(st, r, rs);
  }

  private async clash(st: RunState): Promise<void> {
    const [, clashRounds, offset] = this.roundPlan(st.cfg);
    let lastMove: Move | null = null;
    for (let i = 0; i < clashRounds; i++) {
      const r = (st.roundNo = offset + 1 + i);
      if (this.budgetGuard(st, Phase.CLASH)) {
        break;
      }
      const opener = st.order.length ? st.order[r % st.order.length]! : 'A';
      const [first, second] = opener === 'A' ? [st.agentA, st.agentB] : [st.agentB, st.agentA];
      const movePrompt =
        `${st.brief}\nMake ONE typed move (CLAIM/WHY/ARGUE/REBUT/UNDERCUT/CONCEDE/RETRACT) as JSON.`;
      const m1 = await first.requestMove(movePrompt, r);
      const m2 = await second.requestMove(movePrompt, r);
      const pairs: Array<[Move, Move | null]> = [
        [m1, lastMove],
        [m2, m1],
      ];
      for (const [mv, target] of pairs) {
        await st.judge.tagMove(mv, target);
        st.moves.push(mv);
      }
      lastMove = m2;
      const [textA, textB] = opener === 'A' ? [m1.content, m2.content] : [m2.content, m1.content];
      this.recordTurn(st, 'agent_a', Phase.CLASH, r, textA);
      this.recordTurn(st, 'agent_b', Phase.CLASH, r, textB);
      await st.judge.selectSnippets(st.snippetPool, `${textA} ${textB}`, 3);
      const rs = await st.judge.scoreRound(
        textA,
        textB,
        st.cfg.scoringScale,
        tierValue(st.cfg.rigorTier),
        r,
        Phase.CLASH,
      );
      st.result.roundScores.push(rs);
      st.result.violations.push(...rs.violations);
      this.chargeJudge(st, textA + textB, Phase.CLASH);
      // CAPTURE: harvest the full move rationales (the worst v2.0 leak).
      const harvested = await this.harvest(st, `${textA}\n${textB}`, Phase.CLASH, r);
      this.setIdeaQuality(st, r, rs);
      // VERIFY (event-triggered): a dispute this round → verify the most-novel insight.
      const disputed = [m1, m2].some(
        (m) => m.moveType === MoveType.REBUT || m.moveType === MoveType.UNDERCUT,
      );
      if (disputed && harvested.length > 0) {
        await this.verifyInsights(st, harvested.slice(0, 1), Phase.CLASH);
      }
      if (shouldStop(st.ledger, st.result.roundScores)) {
        this.log(st, 'stability_stop', Phase.CLASH, `stopped at round ${r}`);
        break;
      }
    }
  }

  private async recommend(st: RunState): Promise<void> {
    const draftA = await st.agentA.speak([{ role: 'user', content: 'Give your synthesis bullets.' }]);
    const draftB = await st.agentB.speak([{ role: 'user', content: 'Give your synthesis bullets.' }]);
    const synthesis = await st.judge.synthesize(draftA, draftB, st.ledger);
    st.result.conversation.push({
      actor: 'judge',
      phase: Phase.RECOMMEND,
      round: st.roundNo + 1,
      content: synthesis,
    });
    // Capture late insights + a boundary verify sweep on unverified high-novelty ones.
    await this.harvest(
      st,
      `${draftA}\n${draftB}\n${synthesis}`,
      Phase.RECOMMEND,
      st.roundNo + 1,
      true,
    );
    const unverified = st.ledger.insights.filter((i) => i.status === InsightStatus.CAPTURED);
    await this.verifyInsights(st, topNovel(unverified, 2), Phase.RECOMMEND);
    this.distill(st);
    this.log(
      st,
      'keypoint_distilled',
      Phase.RECOMMEND,
      `${st.result.validatedKeyPoints.length} key-points, ` +
        `${st.result.candidateInsights.length} candidates`,
    );
  }

  private distill(st: RunState): void {
    const eligible = st.ledger.eligibleInsights(VERIFIED_STATUSES);
    const clusters = eligible.length ? st.ledger.kpaCluster(eligible) : [];
    const leaders = mmrSelect(
      clusters.map((c) => c[0]!),
      st.embeddings,
      8,
    );
    st.result.validatedKeyPoints = leaders.map((ins) =>
      makeKeyPoint({
        id: 'kp-' + randomUUID().replace(/-/g, '').slice(0, 8),
        text: ins.text,
        prevalence: clusterSize(clusters, ins),
        originTurns: ins.sourceTurn ? [ins.sourceTurn] : [ins.id],
        verificationId: ins.verificationId,
        originality: ins.originality,
        feasibility: ins.feasibility,
        novelty: ins.novelty,
        tier: KeyPointTier.VALIDATED,
      }),
    );
    // LD7: never silently drop a breakthrough — keep flagged high-novelty unverified.
    st.result.candidateInsights = st.ledger.insights.filter(
      (i) => i.status === InsightStatus.CAPTURED || i.status === InsightStatus.UNVERIFIABLE,
    );
  }

  private async close(st: RunState): Promise<void> {
    const [args, attacks] = buildAttackGraph(st.moves);
    const grounded = groundedExtension(args, attacks);
    st.result.entropy = computeEntropyMetrics(st.ledger);
    const rounds = st.result.roundScores;
    const disagreements = rounds.filter((r) => r.drawFromDisagreement).length;
    const swapAgree = rounds.length ? 1.0 - disagreements / rounds.length : 1.0;
    const meanDelta = rounds.length
      ? (rounds.reduce((s, r) => s + r.judgeUncertainty, 0) / rounds.length) * 10
      : 0.0;
    const reliability = makeReliabilityStats({
      swapWinnerAgreement: swapAgree,
      meanDimensionDelta: meanDelta,
      judgeUncertainty: meanDelta / 10,
      poolEligible: swapAgree >= 0.7 && meanDelta <= 2.0,
    });
    st.result.reliability = reliability;
    const gic = Math.min(1.0, st.ledger.goodIdeaCount() / 12.0);
    st.result.normalized = normalizeV2(rounds, gic, st.result.violations.length);
    st.result.weights = computeComposite(st.ledger, reliability, st.result.violations);
    const [rtype, cflag] = classifyResult(
      st.result.normalized.validityDifferential,
      gic,
      st.result.entropy.stdSelfInfo,
      DEFAULT_SIGMA_HI,
    );
    st.result.resultType = rtype;
    st.result.complexityFlag = cflag;
    st.result.ideaLedger = st.ledger.ideas;
    st.result.insights = st.ledger.insights;
    st.result.coverageReport = coverageReport(
      st.ledger,
      st.ledger.insights.length || null,
      st.harvester.lastOmissionPasses,
    );
    st.result.roundCount = rounds.length;
    st.result.roundsToStability = rounds.length;
    st.result.totalTokens = st.budget.grandTotal;
    st.result.reliability.poolEligible = reliability.poolEligible;
    this.log(
      st,
      'session_end',
      Phase.CLOSE,
      `grounded=${grounded.size} composite=${st.result.weights.composite.toFixed(3)}`,
    );
  }

  // -- shared mechanics -------------------------------------------------
  private async harvest(
    st: RunState,
    transcript: string,
    phase: string,
    r: number,
    atBoundary = false,
  ): Promise<InsightRecord[]> {
    const ctx = {
      phase,
      author_agent: 'A',
      author_model_family: st.cfg.agentA.modelFamily,
      families: { A: st.cfg.agentA.modelFamily, B: st.cfg.agentB.modelFamily },
      source_turn: `r${r}`,
    };
    const insights = await st.harvester.harvestRound(transcript, ctx, tierValue(st.cfg.rigorTier), atBoundary);
    if (insights.length > 0) {
      await st.ledger.ingestInsights(insights);
      this.log(st, 'insight_harvested', phase, `round ${r}: ${insights.length} insights`);
      this.chargeHarvest(st, transcript, phase);
    }
    return insights;
  }

  private async verifyInsights(st: RunState, insights: InsightRecord[], phase: string): Promise<void> {
    for (const ins of insights) {
      // LD8: pick a verifier family different from the author.
      let vf = st.cfg.judge.modelFamily;
      if (vf === ins.authorModelFamily) {
        vf =
          ins.authorModelFamily !== st.cfg.agentB.modelFamily
            ? st.cfg.agentB.modelFamily
            : st.cfg.agentA.modelFamily;
      }
      let vr;
      try {
        vr = await st.judge.verifyInsight(ins, st.snippetPool, vf);
      } catch (exc) {
        if (isValueError(exc)) {
          st.result.violations.push(
            makeViolation({
              kind: 'verifier_family_mismatch',
              description: 'could not source a disjoint verifier',
              actor: 'judge',
            }),
          );
          continue;
        }
        throw exc;
      }
      st.result.verificationRecords.push(vr);
      const action =
        ({
          [InsightStatus.GROUNDED]: 'insight_verified',
          [InsightStatus.REFUTED]: 'insight_refuted',
          [InsightStatus.UNVERIFIABLE]: 'insight_unverifiable',
        } as Record<string, string>)[vr.status] ?? 'insight_scrutinized';
      this.log(st, action, phase, `insight ${ins.id} -> ${vr.status}`);
      this.chargeVerify(st, ins.text, phase);
    }
  }

  // Judge generativity (0–30) → idea quality (0–10), server-side only (not shown to agents).
  private setIdeaQuality(st: RunState, r: number, rs: RoundScore): void {
    const qa = dimScoresGenerativityTotal(rs.dimMeansA) / 3.0;
    const qb = dimScoresGenerativityTotal(rs.dimMeansB) / 3.0;
    for (const idea of st.ledger.roundIdeas(r, 'A')) {
      idea.quality = Math.max(idea.quality, qa);
    }
    for (const idea of st.ledger.roundIdeas(r, 'B')) {
      idea.quality = Math.max(idea.quality, qb);
    }
  }

  private budgetGuard(st: RunState, phase: string): boolean {
    if (st.budget.shouldWarn75() && !st.converged) {
      st.converged = true;
      st.agentA.injectContext(CONVERGE_MESSAGE);
      st.agentB.injectContext(CONVERGE_MESSAGE);
      st.result.conversation.push({
        actor: 'system',
        phase,
        round: st.roundNo,
        content: CONVERGE_MESSAGE,
      });
      this.log(st, 'budget_warning', phase, '75% — converge injected');
    }
    if (st.budget.shouldWarn95()) {
      st.result.conversation.push({
        actor: 'system',
        phase,
        round: st.roundNo,
        content: FINAL_MESSAGE,
      });
      this.log(st, 'budget_warning', phase, '95% — final statement injected');
    }
    if (st.budget.isExhausted() || st.budget.phaseExhausted(phase)) {
      st.result.conversation.push({
        actor: 'system',
        phase,
        round: st.roundNo,
        content: FORCE_END_MESSAGE,
      });
      this.log(st, 'budget_warning', phase, 'exhausted — terminating');
      return true;
    }
    return false;
  }

  private recordTurn(st: RunState, actor: string, phase: string, r: number, text: string): void {
    st.result.conversation.push({ actor, phase, round: r, content: text.slice(0, 2000) });
    const client = actor === 'agent_a' ? st.agentA : st.agentB;
    this.chargeAgent(st, client, text, phase);
  }

  private chargeAgent(st: RunState, client: AgentClient, text: string, phase: string): void {
    const pu = client.lastUsage.prompt ?? 0;
    let cu = client.lastUsage.completion ?? 0;
    if (pu + cu === 0) {
      cu = BudgetTracker.estimateTokens(text);
    }
    st.budget.addAgentUsage(pu, cu, phase);
  }

  private chargeJudge(st: RunState, text: string, phase: string): void {
    st.budget.addJudgeUsage(BudgetTracker.estimateTokens(text), 64, phase);
  }

  private chargeHarvest(st: RunState, text: string, phase: string): void {
    st.budget.addHarvestVerifyUsage(BudgetTracker.estimateTokens(text), 48, phase);
  }

  private chargeVerify(st: RunState, text: string, phase: string): void {
    st.budget.addHarvestVerifyUsage(BudgetTracker.estimateTokens(text), 48, phase);
  }

  private log(st: RunState, action: string, phase: string, description: string): void {
    const event = makeAuditEvent({ action, phase, description });
    st.result.auditLog.push(event);
    // N1 additive surface: emit phase-grain progress. A faulty sink must NEVER
    // break a run, so the call is fully guarded (engine purity preserved).
    if (this._onEvent !== null) {
      try {
        this._onEvent(event);
      } catch {
        // never let a progress sink abort the debate
      }
    }
  }

  // Return [proposeRounds, clashRounds, clashOffset].
  //
  // Default (proposeClashSplit === null) reproduces upstream behavior EXACTLY:
  // propose=max(1, R//2), clash=max(1, R - R//2), clash offset=R//2.
  // A split (proposeFrac, clashFrac) scales the counts (offset=propose count).
  private roundPlan(cfg: UnitConfig): [number, number, number] {
    const R = cfg.maxRounds;
    if (cfg.proposeClashSplit) {
      const pr = Math.max(1, pyRound(R * cfg.proposeClashSplit[0]));
      return [pr, Math.max(1, R - pr), pr];
    }
    const half = Math.trunc(R / 2);
    return [Math.max(1, half), Math.max(1, R - half), half];
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

// Exported so the panel engine (orchestrator/multiDebate) reuses the same
// primitive Python imported as unit.engine._tier_value (single source of truth).
export function tierValue(tier: unknown): string {
  if (typeof tier === 'object' && tier !== null && 'value' in tier) {
    return String((tier as { value: unknown }).value);
  }
  if ((Object.values(RigorTier) as string[]).includes(String(tier))) {
    return String(tier);
  }
  return String(tier);
}

function topNovel(insights: InsightRecord[], k: number): InsightRecord[] {
  return [...insights]
    .sort((a, b) => {
      if (b.selfInfo !== a.selfInfo) {
        return b.selfInfo - a.selfInfo;
      }
      return b.novelty - a.novelty;
    })
    .slice(0, k);
}

// Minimal shape the MMR helper reads off ledger leaders.
export interface MmrItem {
  text: string;
  embedding: number[] | null;
  novelty: number;
  survivedScrutiny: number | null;
}

// Greedy MMR: balance relevance (novelty/survival) against redundancy (P8/§4.12).
// Exported (Python unit.engine._mmr_select) so the panel engine reuses it.
export function mmrSelect<T extends MmrItem>(leaders: T[], _embeddings: EmbeddingsClient | null, k: number, lam = 0.7): T[] {
  const sim = (a: MmrItem, b: MmrItem): number => {
    if (a.embedding !== null && b.embedding !== null) {
      return EmbeddingsClient.cosine(a.embedding, b.embedding);
    }
    return EmbeddingsClient.jaccard(a.text, b.text);
  };

  const pool = [...leaders];
  const selected: T[] = [];
  while (pool.length > 0 && selected.length < k) {
    let best: T | null = null;
    let bestScore = -Infinity;
    for (const cand of pool) {
      const rel = cand.novelty || (cand.survivedScrutiny ?? 0.0);
      const div = selected.length > 0 ? Math.max(...selected.map((s) => sim(cand, s))) : 0.0;
      const score = lam * rel - (1 - lam) * div;
      if (score > bestScore) {
        best = cand;
        bestScore = score;
      }
    }
    selected.push(best!);
    pool.splice(pool.indexOf(best!), 1);
  }
  return selected;
}

// Python: next((len(c) for c in clusters if c[0] is ins), 1) — first cluster led by ins.
function clusterSize(clusters: InsightRecord[][], ins: InsightRecord): number {
  for (const c of clusters) {
    if (c[0] === ins) {
      return c.length;
    }
  }
  return 1;
}

// Python round(): banker's rounding (round-half-to-even).
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

// Render a {A: 'x', B: 'y'} stance map the way Python str(dict) would, so the
// stance_assigned audit description stays byte-faithful to the source.
function pyDictRepr(d: Record<string, string>): string {
  const parts = Object.entries(d).map(([k, v]) => `'${k}': '${v}'`);
  return `{${parts.join(', ')}}`;
}

function isValueError(exc: unknown): boolean {
  // judge.verifyInsight throws a plain Error for the verifier-family mismatch
  // (Python raised ValueError); match by message to mirror the `except ValueError`.
  return exc instanceof Error && /must differ from author family/.test(exc.message);
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
