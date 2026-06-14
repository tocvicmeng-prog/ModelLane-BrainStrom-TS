// multiDebate.ts (N-panel) — N-debater "panel" group engine (>2 debaters in ONE group).
//
// The Unit Cell engine debates EXACTLY two agents (full pairwise validity + swap scoring).
// This panel engine generalizes a single group to N>=2 debaters by reusing the Unit Cell
// PRIMITIVES — research, the Judge's generative role + first-principles verification, the
// Harvester, the IdeaLedger, MMR distillation, and entropy/σ_SI metrics — while emphasizing
// the IDEATION signals that generalize to any number of authors (insight capture,
// verification, diversity) rather than the two-party validity tournament, which does not.
//
// It produces the same InterimConclusion the chief scribe consumes. groupRunner routes
// groups with >2 debater seats here; 2-seat groups keep using the full Unit Cell engine
// (this is the N>2 PATH, not a replacement). The golden engine is left untouched.

import { BudgetTracker } from '../engine/budget';
import { mmrSelect, tierValue } from '../engine/engine';
import { EmbeddingsClient } from '../engine/embeddings';
import { HarvestContext } from '../engine/harvester';
import { computeEntropyMetrics } from '../engine/metrics';
import { IdeaLedger } from '../engine/ledger';
import {
  VERIFIED_STATUSES,
  InsightStatus,
  MoveType,
  Phase,
  type IdeaRecord,
  type InsightRecord,
  type Move,
} from '../engine/types';

import {
  GroupEvent,
  GroupResult,
  GroupSpec,
  InterimConclusion,
  interimConclusionToDict,
  makeGroupEvent,
  makeGroupResult,
  makeInterimConclusion,
  modeProfile,
} from './types';

const _CAPTURED: string = InsightStatus.CAPTURED;
const _UNVERIFIABLE: string = InsightStatus.UNVERIFIABLE;
const _DISPUTE: readonly string[] = [MoveType.REBUT, MoveType.UNDERCUT];

// -- duck-typed injected clients (mirror the Python `object` / structural typing) ----

/** One panel debater (duck-typed: speak / requestSlips / requestMove / modelFamily). */
export interface PanelDebater {
  modelFamily: string;
  injectContext(knowledge: string): void;
  speak(conversation: { role: string; content: string }[], temperature?: number): Promise<string>;
  requestSlips(prompt: string, roundNumber?: number, phase?: string): Promise<IdeaRecord[]>;
  requestMove(prompt: string, roundNumber?: number, phase?: string): Promise<Move>;
}

/** The Judge primitive the panel reuses (generative role + first-principles verify). */
export interface PanelJudge {
  config?: { modelFamily?: string } | null;
  study(markdown: string): Promise<string>;
  generateBrief(topic: string, studyNotes: string): Promise<string>;
  selectSnippets(pool: string[], transcript: string, k?: number): Promise<string[]>;
  synthesize(draftA: string, draftB: string, ledger?: unknown): Promise<string>;
  tagMove(move: Move, target?: Move | null): Promise<Move>;
  verifyInsight(insight: InsightRecord, kbExternal: string[], verifierFamily?: string | null): Promise<unknown>;
}

/** The harvester primitive (best-effort capture; never fatal). */
export interface PanelHarvester {
  harvestRound(
    roundTranscript: string,
    context?: HarvestContext | null,
    tier?: string,
    atBoundary?: boolean,
  ): Promise<InsightRecord[]>;
}

/** The research primitive (OFF by default; corpus → packets + snippet pool). */
export interface PanelResearch {
  routeSearch(topic: string, directives?: string, limit?: number): Promise<string>;
  splitPackets(corpus: string, overlapRatio?: number): { forA: string; forB: string };
  chunkCorpus(corpus: string, maxChars?: number): string[];
}

// The injected components for an N-debater panel (all connector-built / egress-guarded).
// Pure-data dataclass with no defaults -> interface (no factory).
export interface PanelClients {
  debaters: PanelDebater[]; // N AgentClients
  judge: PanelJudge; // JudgeEngine (holds its own injected client)
  embeddings: EmbeddingsClient;
  harvester: PanelHarvester;
  research: PanelResearch;
}

/** Optional streaming sink — receives one GroupEvent per emitted milestone. */
export type PanelEmit = (event: GroupEvent) => void;

export interface RunPanelOptions {
  emit?: PanelEmit | null;
  tokenBudget?: number;
  rngSeed?: number;
}

export async function runPanel(
  spec: GroupSpec,
  panel: PanelClients,
  options: RunPanelOptions = {},
): Promise<GroupResult> {
  const emit = options.emit ?? null;
  const tokenBudget = options.tokenBudget ?? 60_000;
  // rngSeed is accepted for parity with the Python signature; the panel engine is
  // deterministic by index and does not draw from the RNG (kept for API symmetry).
  void options.rngSeed;

  const debaters = panel.debaters;
  if (debaters.length < 2) {
    return makeGroupResult({
      groupId: spec.groupId,
      interim: null,
      unitResult: null,
      error: 'panel requires >=2 debaters',
    });
  }
  const labels = debaters.map((_d, i) => String.fromCharCode('A'.charCodeAt(0) + i));
  const families = debaters.map((d) => d.modelFamily ?? 'unknown');
  const judgeFamily = panel.judge.config?.modelFamily ?? 'judge-family';
  const prof = modeProfile(spec.mode, spec.point.kind);
  const tier = tierValue(prof.rigorTier);
  const maxRounds = prof.maxRounds ?? 4;
  const ledger = new IdeaLedger(panel.embeddings);
  const budget = new BudgetTracker(tokenBudget);

  const _emit = (kind: string, payload: Record<string, unknown>): void => {
    if (emit !== null) {
      emit(makeGroupEvent({ groupId: spec.groupId, kind, payload, sessionId: spec.sessionId }));
    }
  };

  const _charge = (text: string): void => {
    budget.addAgentUsage(0, BudgetTracker.estimateTokens(text || ''), Phase.PROPOSE);
  };

  const _harvest = async (
    text: string,
    phase: string,
    label: string,
    family: string,
    r: number,
  ): Promise<InsightRecord[]> => {
    const familiesMap: Record<string, string> = {};
    for (let i = 0; i < labels.length; i++) {
      familiesMap[labels[i]!] = families[i]!;
    }
    const ctx: HarvestContext = {
      phase,
      author_agent: label,
      author_model_family: family,
      families: familiesMap,
      source_turn: `r${r}`,
    };
    let insights: InsightRecord[];
    try {
      insights = await panel.harvester.harvestRound(text, ctx, tier, false);
    } catch {
      // capture is best-effort, never fatal
      return [];
    }
    if (insights.length > 0) {
      await ledger.ingestInsights(insights);
    }
    return insights;
  };

  const _verify = async (insights: InsightRecord[], snippets: string[]): Promise<void> => {
    for (const ins of insights) {
      const author = ins.authorModelFamily;
      const vf = [judgeFamily, ...families].find((f) => f !== author) ?? author;
      try {
        await panel.judge.verifyInsight(ins, snippets, vf);
      } catch {
        // a verify failure must not abort the panel
        continue;
      }
    }
  };

  _emit('group.start', {
    point: spec.point.text,
    kind: spec.point.kind,
    mode: spec.mode,
    debaters: families,
  });

  // --- PREP -------------------------------------------------------------
  const corpus = await panel.research.routeSearch(spec.point.text);
  const notes = await panel.judge.study(corpus);
  const packet = panel.research.splitPackets(corpus, 0.5);
  const snippetPool = panel.research.chunkCorpus(corpus);
  for (let i = 0; i < debaters.length; i++) {
    debaters[i]!.injectContext(i % 2 === 0 ? packet.forA : packet.forB);
  }
  if (spec.priorContext) {
    for (const d of debaters) {
      d.injectContext(spec.priorContext);
    }
  }
  _emit('group.phase', { action: 'prep', phase: Phase.INJECT });

  // --- OPEN -------------------------------------------------------------
  const brief = await panel.judge.generateBrief(spec.point.text, String(notes.length));
  _emit('group.phase', { action: 'brief_frozen', phase: Phase.OPEN });
  let synthesis = '';

  try {
    // --- PROPOSE (each debater drafts; harvest all) -------------------
    const slipPrompt = `Topic: ${spec.point.text}\n${brief}\nList 3 new idea slips (<=50 words each) as JSON.`;
    const proposeRounds = Math.max(1, Math.trunc(maxRounds / 2));
    for (let r = 0; r < proposeRounds + 1; r++) {
      // round 0 (solo) + proposeRounds
      if (r > 0 && budget.isExhausted()) {
        break;
      }
      for (let i = 0; i < debaters.length; i++) {
        const label = labels[i]!;
        const fam = families[i]!;
        const d = debaters[i]!;
        const slips = await d.requestSlips(slipPrompt, r);
        const text = slips.map((s) => s.text).join(' ');
        await ledger.ingest(slips);
        _charge(text);
        await _harvest(text, Phase.PROPOSE, label, fam, r);
      }
      ledger.dedup();
      _emit('group.phase', { action: 'propose_round', phase: Phase.PROPOSE, round: r });
    }

    // --- CLASH (each debater makes one typed move/round) -------------
    const movePrompt =
      `${brief}\nMake ONE typed move ` +
      `(CLAIM/WHY/ARGUE/REBUT/UNDERCUT/CONCEDE/RETRACT) as JSON.`;
    const clashRounds = Math.max(1, maxRounds - proposeRounds);
    let lastMove: Move | null = null;
    for (let i = 0; i < clashRounds; i++) {
      if (budget.isExhausted()) {
        break;
      }
      const r = proposeRounds + 1 + i;
      let disputed = false;
      for (let j = 0; j < debaters.length; j++) {
        const label = labels[j]!;
        const fam = families[j]!;
        const d = debaters[j]!;
        const mv = await d.requestMove(movePrompt, r);
        await panel.judge.tagMove(mv, lastMove);
        lastMove = mv;
        disputed = disputed || _DISPUTE.includes(mv.moveType);
        _charge(mv.content);
        const harvested = await _harvest(mv.content, Phase.CLASH, label, fam, r);
        if (disputed && harvested.length > 0) {
          await _verify(harvested.slice(0, 1), snippetPool);
        }
      }
      await panel.judge.selectSnippets(snippetPool, brief, 3);
      _emit('group.phase', { action: 'clash_round', phase: Phase.CLASH, round: r });
    }

    // --- RECOMMEND (all draft; judge synthesizes; boundary verify) ---
    const drafts: string[] = [];
    for (const d of debaters) {
      drafts.push(await d.speak([{ role: 'user', content: 'Give your synthesis bullets.' }]));
    }
    const combined = drafts.join('\n');
    synthesis = await panel.judge.synthesize(combined, '', ledger);
    const boundary = await _harvest(
      `${combined}\n${synthesis}`,
      Phase.RECOMMEND,
      labels[0]!,
      families[0]!,
      proposeRounds + clashRounds + 1,
    );
    const unverified = ledger.insights.filter((ins) => ins.status === _CAPTURED);
    await _verify([...boundary, ...unverified].slice(0, 3), snippetPool);
    _emit('group.phase', { action: 'recommend', phase: Phase.RECOMMEND });
  } catch (exc) {
    // never lose what was captured
    _emit('group.error', { error: errLabel(exc) });
  }

  // --- DISTILL + CLOSE --------------------------------------------------
  const eligible = ledger.eligibleInsights(VERIFIED_STATUSES);
  const clusters = eligible.length > 0 ? ledger.kpaCluster(eligible) : [];
  const leaders =
    clusters.length > 0 ? mmrSelect(clusters.map((c) => c[0]!), panel.embeddings, 8) : [];
  const validated = leaders.map((ins) => ins.text);
  const candidates = ledger.insights
    .filter((ins) => ins.status === _CAPTURED || ins.status === _UNVERIFIABLE)
    .map((ins) => ins.text);
  const entropy = computeEntropyMetrics(ledger);
  const evidence =
    validated.length > 0 ? 'grounded' : candidates.length > 0 ? 'candidates-only' : 'inconclusive';

  const interim: InterimConclusion = makeInterimConclusion({
    groupId: spec.groupId,
    pointId: spec.point.id,
    summary: synthesis,
    validatedKeyPoints: validated,
    candidateInsights: candidates,
    evidenceStatus: evidence,
    sigmaSi: entropy.stdSelfInfo ?? null,
    composite: null,
    participation: families,
    degraded: Boolean(panel.embeddings.degraded ?? false),
  });
  _emit('group.interim', interimConclusionToDict(interim));
  return makeGroupResult({ groupId: spec.groupId, interim, unitResult: null, error: null });
}

// Python: f"{type(exc).__name__}: {exc}".
function errLabel(exc: unknown): string {
  if (exc instanceof Error) {
    return `${exc.name}: ${exc.message}`;
  }
  return `Error: ${String(exc)}`;
}
