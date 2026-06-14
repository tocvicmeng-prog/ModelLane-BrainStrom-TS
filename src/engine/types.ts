// types.ts (N1) — Core data contract for the Unit Cell debate engine (v2.1).
//
// Pure data layer: interfaces + enums + a handful of pure helpers (classification
// thresholds, dataclass-default factories, JSON (de)serialisation, session-id
// minting). No LLM, no HTTP, no SQLite/filesystem I/O (the Python module's
// save/load/query persistence lives outside this faithful port).
//
// Naming map (Python @dataclass -> TS): pure-data dataclasses become an interface
// plus a makeX(partial?) factory reproducing the defaults; dataclasses that had
// methods become classes; snake_case fields become camelCase.

// ---------------------------------------------------------------------------
// Chat message type used by agents (frozen API).
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Calibration constants (conservative defaults; only kFromGoldSet and the
// verification-escalation threshold are tuned at M4 — CONSTITUTION §4 / plan).
// ---------------------------------------------------------------------------

export const DEFAULT_THETA_DUP = 0.92;     // cosine dedup threshold (ledger.dedup)
export const DEFAULT_THETA_Q = 6.0;        // "good idea" quality floor (0–10 scale)
export const DEFAULT_TAU = 3.0;            // draw threshold on the 0–30 validity channel
export const DEFAULT_DELTA_OPEN = 0.15;    // opening-diversity floor (1 - cos of A/B centroids)
export const DEFAULT_SIGMA_HI = 1.5;       // σ_SI "high complexity" threshold (tuned at M4)
export const DEFAULT_CLUSTER_SIM = 0.75;   // greedy-leader clustering cosine threshold
export const DEFAULT_NOVELTY_FLOOR = 0.2;  // ν_min: novel-unit-rate stop floor (shouldStop)
export const DEFAULT_OVERLAP_RATIO = 0.5;  // shared-core fraction of the knowledge packets

// Composite weight v2 term weights (P3). VD/IND drop-and-renormalise when absent.
export const COMPOSITE_WEIGHTS: Record<string, number> = {
  TS: 0.3,
  MD: 0.2,
  GIC: 0.15,
  JR: 0.15,
  VD: 0.1,
  IND: 0.1,
};

// ---------------------------------------------------------------------------
// Enums (string-valued; values byte-identical to Python).
// ---------------------------------------------------------------------------

export const RigorTier = {
  ECONOMY: 'economy',
  STANDARD: 'standard',
  HIGH_STAKES: 'high_stakes',
} as const;
export type RigorTier = (typeof RigorTier)[keyof typeof RigorTier];

export const JudgeMode = {
  LOCAL: 'local',
  HUMAN: 'human',
} as const;
export type JudgeMode = (typeof JudgeMode)[keyof typeof JudgeMode];

export const Phase = {
  CONFIG: 'config',
  RESEARCH: 'research',
  STUDY: 'study',
  INJECT: 'inject',
  OPEN: 'open',
  PROPOSE: 'propose',
  CLASH: 'clash',
  RECOMMEND: 'recommend',
  CLOSE: 'close',
  REVIEW: 'review',
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const MoveType = {
  CLAIM: 'CLAIM',
  WHY: 'WHY',
  ARGUE: 'ARGUE',
  REBUT: 'REBUT',
  UNDERCUT: 'UNDERCUT',
  CONCEDE: 'CONCEDE',
  RETRACT: 'RETRACT',
} as const;
export type MoveType = (typeof MoveType)[keyof typeof MoveType];

// Per-phase legal move sets (P7 / ARCHITECTURE §4.9).
export const LEGAL_MOVES: Record<string, Set<string>> = {
  [Phase.PROPOSE]: new Set<string>([MoveType.CLAIM, MoveType.WHY]),
  [Phase.CLASH]: new Set<string>(Object.values(MoveType)),
  [Phase.RECOMMEND]: new Set<string>([MoveType.CONCEDE, MoveType.ARGUE]),
};

export const ResultType = {
  DECISIVE: 'decisive',
  TILTED: 'tilted',
  CONTROVERSIAL: 'controversial',
} as const;
export type ResultType = (typeof ResultType)[keyof typeof ResultType];

export const ComplexityFlag = {
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
} as const;
export type ComplexityFlag = (typeof ComplexityFlag)[keyof typeof ComplexityFlag];

// Lifecycle of a captured insight (ARCHITECTURE §7.2 ideas.verification_status).
export const InsightStatus = {
  CAPTURED: 'captured', // harvested, not yet verified
  GROUNDED: 'grounded', // atoms externally entailed (strongest)
  SCRUTINIZED: 'scrutinized', // survived challenge, not externally grounded
  REFUTED: 'refuted', // a load-bearing premise was refuted
  UNVERIFIABLE: 'unverifiable', // cannot reduce to checkable atoms (never a pass)
  QUARANTINED: 'quarantined', // kept-but-flagged (P8 quarantine-but-keep)
} as const;
export type InsightStatus = (typeof InsightStatus)[keyof typeof InsightStatus];

// Statuses that count as "verified" for the VerifiedDepth term (P16).
export const VERIFIED_STATUSES: readonly string[] = [
  InsightStatus.GROUNDED,
  InsightStatus.SCRUTINIZED,
];

export const HarvestSource = {
  SLIP: 'slip',
  MOVE_RATIONALE: 'move_rationale',
  LONG_FORM: 'long_form',
  SYNTHESIS: 'synthesis',
} as const;
export type HarvestSource = (typeof HarvestSource)[keyof typeof HarvestSource];

export const KeyPointTier = {
  VALIDATED: 'validated',
  CANDIDATE: 'candidate',
} as const;
export type KeyPointTier = (typeof KeyPointTier)[keyof typeof KeyPointTier];

export const IdeaStatus = {
  ACTIVE: 'active',
  MERGED: 'merged',
  RETRACTED: 'retracted',
} as const;
export type IdeaStatus = (typeof IdeaStatus)[keyof typeof IdeaStatus];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// One debate agent (A or B). Diversity levers (P15): model/persona/seed/temp.
export interface AgentConfig {
  name: string;
  endpoint: string;
  model: string;
  apiKey: string | null;
  systemPrompt: string;
  modelFamily: string; // used for verifier≠author enforcement (LD8)
  persona: string;
  temperature: number;
  seed: number | null;
}

export function makeAgentConfig(partial?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'Agent',
    endpoint: 'http://localhost:1234/v1',
    model: 'local-model',
    apiKey: null,
    systemPrompt: '',
    modelFamily: 'unknown',
    persona: '',
    temperature: 0.7,
    seed: null,
    ...partial,
  };
}

export interface EmbeddingsConfig {
  endpoint: string;
  model: string;
  apiKey: string | null;
  expectedDim: number | null; // if set, a mismatch raises (dimension guard)
  cacheDir: string;
}

export function makeEmbeddingsConfig(partial?: Partial<EmbeddingsConfig>): EmbeddingsConfig {
  return {
    endpoint: 'http://localhost:1234/v1',
    model: 'nomic-embed-text',
    apiKey: null,
    expectedDim: null,
    cacheDir: './data/cache/embeddings',
    ...partial,
  };
}

// Win/draw/loss point values. Invariant: win > draw >= loss (P6).
export interface ScoringScale {
  win: number;
  draw: number;
  loss: number;
}

export function makeScoringScale(partial?: Partial<ScoringScale>): ScoringScale {
  return { win: 3, draw: 1, loss: 0, ...partial };
}

export function scoringScaleIsValid(s: ScoringScale): boolean {
  return s.win > s.draw && s.draw >= s.loss;
}

// Evaluative + generative judge settings (P5).
export interface JudgeConfig {
  endpoint: string;
  model: string;
  apiKey: string | null;
  modelFamily: string;
  rigorTier: RigorTier;
  scoringScale: ScoringScale;
  tau: number;
  securityWrap: boolean; // delimiter-wrap + anonymise debater text (P4)
  injectionDetection: boolean;
}

export function makeJudgeConfig(partial?: Partial<JudgeConfig>): JudgeConfig {
  return {
    endpoint: 'http://localhost:1234/v1',
    model: 'local-judge',
    apiKey: null,
    modelFamily: 'judge-family',
    rigorTier: RigorTier.STANDARD,
    scoringScale: makeScoringScale(),
    tau: DEFAULT_TAU,
    securityWrap: true,
    injectionDetection: true,
    ...partial,
  };
}

// Doc alias: ARCHITECTURE §2 names the type ``JudgingConfig``.
export type JudgingConfig = JudgeConfig;
export const makeJudgingConfig = makeJudgeConfig;

// Top-level run configuration (ARCHITECTURE §1 Configuration Layer).
export interface UnitConfig {
  topic: string;
  agentA: AgentConfig;
  agentB: AgentConfig;
  judge: JudgeConfig;
  embeddings: EmbeddingsConfig;
  rules: string[];
  searchDirectives: string;
  tokenBudget: number;
  judgeMode: JudgeMode;
  scoringScale: ScoringScale;
  rigorTier: RigorTier;
  overlapRatio: number;
  maxRounds: number;
  allowIntervention: boolean;
  agentTimeout: number;
  agentMaxRetries: number;
  sessionId: string | null;
  // Dual-working-model role temperatures (LD8): brainstorm hot, verify cold.
  generatorTemp: number;
  verifierTemp: number;
  // --- N1 additive surface (ModelLane-BrainStrom) -------------------------
  // Both default to null => byte-identical to upstream Unit Cell behavior.
  // Debate MODES set these as presets over existing knobs.
  proposeClashSplit: [number, number] | null; // (proposeFrac, clashFrac) over maxRounds
  objective: string | null; // debate-mode objective LABEL; engine does not act on it
}

export function makeUnitConfig(partial?: Partial<UnitConfig>): UnitConfig {
  return {
    topic: 'Untitled topic',
    agentA: makeAgentConfig({ name: 'Agent A', modelFamily: 'family-a' }),
    agentB: makeAgentConfig({ name: 'Agent B', modelFamily: 'family-b' }),
    judge: makeJudgeConfig(),
    embeddings: makeEmbeddingsConfig(),
    rules: [],
    searchDirectives: '',
    tokenBudget: 100_000,
    judgeMode: JudgeMode.LOCAL,
    scoringScale: makeScoringScale(),
    rigorTier: RigorTier.STANDARD,
    overlapRatio: DEFAULT_OVERLAP_RATIO,
    maxRounds: 8,
    allowIntervention: true,
    agentTimeout: 120,
    agentMaxRetries: 2,
    sessionId: null,
    generatorTemp: 0.9,
    verifierTemp: 0.2,
    proposeClashSplit: null,
    objective: null,
    ...partial,
  };
}

// A config validation finding (config.validateConfig → ValidationError[]).
export interface ValidationError {
  field: string;
  message: string;
  severity: string; // "error" | "warning"
}

export function makeValidationError(partial: Partial<ValidationError> & { field: string; message: string }): ValidationError {
  return { severity: 'error', ...partial };
}

export function validationErrorIsError(e: ValidationError): boolean {
  return e.severity === 'error';
}

// ---------------------------------------------------------------------------
// Scoring (cardinal two-channel rubric, swap-aggregated — LD1/LD2/P6)
// ---------------------------------------------------------------------------

// Six anchored dimensions, each scored 0–10.
export interface DimScores {
  // Validity channel (comparative, zero-sum framing)
  logic: number;
  evidence: number;
  responsiveness: number;
  // Generativity channel (absolute, non-zero-sum)
  novelty: number;
  assumptions: number;
  motion: number;
}

export function makeDimScores(partial?: Partial<DimScores>): DimScores {
  return {
    logic: 0,
    evidence: 0,
    responsiveness: 0,
    novelty: 0,
    assumptions: 0,
    motion: 0,
    ...partial,
  };
}

export function dimScoresValidityTotal(d: DimScores): number {
  return d.logic + d.evidence + d.responsiveness;
}

export function dimScoresGenerativityTotal(d: DimScores): number {
  return d.novelty + d.assumptions + d.motion;
}

// One judge pass over a round (original or position-swapped order).
export interface ScoringPass {
  passIndex: number;
  order: string; // "original" | "swapped"
  dimsA: DimScores;
  dimsB: DimScores;
  rationale: string;
}

export function makeScoringPass(partial: Partial<ScoringPass> & { passIndex: number; order: string }): ScoringPass {
  return {
    dimsA: makeDimScores(),
    dimsB: makeDimScores(),
    rationale: '',
    ...partial,
  };
}

export function scoringPassValidityTotalA(p: ScoringPass): number {
  return dimScoresValidityTotal(p.dimsA);
}

export function scoringPassValidityTotalB(p: ScoringPass): number {
  return dimScoresValidityTotal(p.dimsB);
}

// Aggregated per-round score; W/L/D derived from validity totals (LD2).
export interface RoundScore {
  roundNumber: number;
  phase: string;
  dimMeansA: DimScores;
  dimMeansB: DimScores;
  validityTotalA: number;
  validityTotalB: number;
  winner: string; // "A" | "B" | "draw"
  drawFromDisagreement: boolean;
  judgeUncertainty: number;
  passes: ScoringPass[];
  violations: Violation[];
}

export function makeRoundScore(partial: Partial<RoundScore> & { roundNumber: number }): RoundScore {
  return {
    phase: Phase.CLASH,
    dimMeansA: makeDimScores(),
    dimMeansB: makeDimScores(),
    validityTotalA: 0,
    validityTotalB: 0,
    winner: 'draw',
    drawFromDisagreement: false,
    judgeUncertainty: 0,
    passes: [],
    violations: [],
    ...partial,
  };
}

// Raw (un-normalised) aggregate over all scored rounds.
export interface RawScores {
  validityTotalA: number;
  validityTotalB: number;
  generativityTotalA: number;
  generativityTotalB: number;
  rounds: number;
}

export function makeRawScores(partial?: Partial<RawScores>): RawScores {
  return {
    validityTotalA: 0,
    validityTotalB: 0,
    generativityTotalA: 0,
    generativityTotalB: 0,
    rounds: 0,
    ...partial,
  };
}

// All fields in [0,1] (Quantifiability tenet). v2 normalisation (CONSTITUTION §5).
export interface NormalizedScores {
  vNormA: number;
  vNormB: number;
  validityDifferential: number; // |V_A−V_B| / (V_A+V_B), guarded
  engagementV2: number; // = goodIdeaCountNorm (ideation, not points)
  violationRate: number;
}

export function makeNormalizedScores(partial?: Partial<NormalizedScores>): NormalizedScores {
  return {
    vNormA: 0,
    vNormB: 0,
    validityDifferential: 0,
    engagementV2: 0,
    violationRate: 0,
    ...partial,
  };
}

export function normalizedScoresAllInUnit(n: NormalizedScores): boolean {
  return [n.vNormA, n.vNormB, n.validityDifferential, n.engagementV2, n.violationRate].every(
    (v) => v >= 0 && v <= 1,
  );
}

// Composite weight v2 (P3). composite ∈ [0,1]; any disqualifying violation → 0.
export interface WeightVector {
  tailScore: number | null; // TS — P95 idea quality / 10
  marginalDiversity: number | null; // MD — set-relative diversity
  goodIdeaCountNorm: number | null; // GIC — min(1, nGood/12)
  judgeReliability: number | null; // JR — swap agreement / α
  verifiedDepth: number | null; // VD — mean survivedScrutiny (v2.1)
  independence: number | null; // IND — pool-level (export-only, null in-cell)
  goodIdeaCount: number;
  weightsUsed: Record<string, number>;
  composite: number;
  disqualified: boolean;
}

export function makeWeightVector(partial?: Partial<WeightVector>): WeightVector {
  return {
    tailScore: null,
    marginalDiversity: null,
    goodIdeaCountNorm: null,
    judgeReliability: null,
    verifiedDepth: null,
    independence: null,
    goodIdeaCount: 0,
    weightsUsed: {},
    composite: 0,
    disqualified: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Typed argument moves + commitment store (P7)
// ---------------------------------------------------------------------------

export interface Move {
  id: string;
  agent: string; // "A" | "B"
  moveType: string; // MoveType value
  content: string;
  targetId: string | null; // the prior move this one targets
  roundNumber: number;
  phase: string;
  validAttack: boolean | null; // judge LOCAL tag (REBUT/UNDERCUT validity)
  fallacy: string | null; // named pragma-dialectical fallacy, if any
}

export function makeMove(partial: Partial<Move> & { id: string; agent: string; moveType: string }): Move {
  return {
    content: '',
    targetId: null,
    roundNumber: 0,
    phase: Phase.CLASH,
    validAttack: null,
    fallacy: null,
    ...partial,
  };
}

export interface CommitmentEntry {
  agent: string;
  proposition: string;
  moveId: string;
  status: string; // "asserted" | "conceded" | "retracted"
  roundNumber: number;
}

export function makeCommitmentEntry(
  partial: Partial<CommitmentEntry> & { agent: string; proposition: string; moveId: string },
): CommitmentEntry {
  return { status: 'asserted', roundNumber: 0, ...partial };
}

// ---------------------------------------------------------------------------
// Idea ledger + entropy (LD4 / P14)
// ---------------------------------------------------------------------------

// A ledger entry. Maps 1:1 to the SQLite ``ideas`` table (ARCHITECTURE §7.2).
// Carries optional v2.1 verification fields so harvested insights and PROPOSE
// slips share one storage shape; ``harvestedFrom`` distinguishes them.
export interface IdeaRecord {
  id: string;
  text: string;
  agent: string;
  roundNumber: number;
  phase: string;
  parentIds: string[];
  modelFamily: string;
  harvestedFrom: string | null; // (v2.1) slip|move_rationale|long_form|synthesis
  embedding: number[] | null;
  quality: number;
  originality: number; // SEPARATE from feasibility (P8)
  feasibility: number;
  novelty: number;
  selfInfo: number;
  clusterId: number | null;
  verificationStatus: string | null; // (v2.1) InsightStatus value
  verificationId: string | null; // (v2.1) FK into verification records
  survivedScrutiny: number | null; // (v2.1) feeds VD; 0 for UNVERIFIABLE
  status: string; // active | merged | retracted
}

export function makeIdeaRecord(partial: Partial<IdeaRecord> & { id: string; text: string }): IdeaRecord {
  return {
    agent: 'A',
    roundNumber: 0,
    phase: Phase.PROPOSE,
    parentIds: [],
    modelFamily: 'unknown',
    harvestedFrom: null,
    embedding: null,
    quality: 0,
    originality: 0,
    feasibility: 0,
    novelty: 0,
    selfInfo: 0,
    clusterId: null,
    verificationStatus: null,
    verificationId: null,
    survivedScrutiny: null,
    status: IdeaStatus.ACTIVE,
    ...partial,
  };
}

export interface EntropyMetrics {
  clusterEntropy: number;
  clusterEntropyNorm: number;
  meanSelfInfo: number;
  stdSelfInfo: number; // σ_SI — PRIMARY tail/breakthrough metric
  fluencyControlledOriginality: number;
  stdSelfInfoVerified: number | null; // (v2.1) SECONDARY telemetry only
  degraded: boolean;
}

export function makeEntropyMetrics(partial?: Partial<EntropyMetrics>): EntropyMetrics {
  return {
    clusterEntropy: 0,
    clusterEntropyNorm: 0,
    meanSelfInfo: 0,
    stdSelfInfo: 0,
    fluencyControlledOriginality: 0,
    stdSelfInfoVerified: null,
    degraded: false,
    ...partial,
  };
}

export interface ReliabilityStats {
  swapWinnerAgreement: number;
  meanDimensionDelta: number;
  judgeUncertainty: number;
  krippendorffAlpha: number | null;
  poolEligible: boolean;
}

export function makeReliabilityStats(partial?: Partial<ReliabilityStats>): ReliabilityStats {
  return {
    swapWinnerAgreement: 1,
    meanDimensionDelta: 0,
    judgeUncertainty: 0,
    krippendorffAlpha: null,
    poolEligible: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// v2.1 — capture / verify / distill
// ---------------------------------------------------------------------------

// A captured innovation point (harvester output; verifyInsight input).
export interface InsightRecord {
  id: string;
  text: string; // decontextualised, atomic
  sourceTurn: string;
  sourcePhase: string;
  authorAgent: string;
  authorModelFamily: string;
  spanType: string;
  harvestedFrom: string;
  embedding: number[] | null;
  dedupClusterId: number | null;
  status: string;
  verificationId: string | null;
  novelty: number;
  originality: number;
  feasibility: number;
  selfInfo: number;
  survivedScrutiny: number | null;
}

export function makeInsightRecord(partial: Partial<InsightRecord> & { id: string; text: string }): InsightRecord {
  return {
    sourceTurn: '',
    sourcePhase: Phase.CLASH,
    authorAgent: 'A',
    authorModelFamily: 'unknown',
    spanType: HarvestSource.LONG_FORM,
    harvestedFrom: HarvestSource.LONG_FORM,
    embedding: null,
    dedupClusterId: null,
    status: InsightStatus.CAPTURED,
    verificationId: null,
    novelty: 0,
    originality: 0,
    feasibility: 0,
    selfInfo: 0,
    survivedScrutiny: null,
    ...partial,
  };
}

// Derive the unified ledger row for entropy/dedup over the whole pool.
export function insightToIdeaRecord(i: InsightRecord): IdeaRecord {
  return makeIdeaRecord({
    id: i.id,
    text: i.text,
    agent: i.authorAgent,
    phase: i.sourcePhase,
    modelFamily: i.authorModelFamily,
    harvestedFrom: i.harvestedFrom,
    embedding: i.embedding,
    quality: i.survivedScrutiny !== null ? i.survivedScrutiny * 10.0 : i.novelty,
    originality: i.originality,
    feasibility: i.feasibility,
    novelty: i.novelty,
    selfInfo: i.selfInfo,
    clusterId: i.dedupClusterId,
    verificationStatus: i.status,
    verificationId: i.verificationId,
    survivedScrutiny: i.survivedScrutiny,
  });
}

export interface PremiseVerdict {
  premise: string;
  verdict: string; // "support" | "refute" | "ambiguous"
  evidence: string;
  kbRef: string | null;
  attackType: string; // "premise" | "inference"
}

export function makePremiseVerdict(
  partial: Partial<PremiseVerdict> & { premise: string; verdict: string },
): PremiseVerdict {
  return { evidence: '', kbRef: null, attackType: 'premise', ...partial };
}

// First-principles verification trace for one insight (R2 / P16).
export interface VerificationRecord {
  id: string;
  insightId: string;
  perPremise: PremiseVerdict[];
  connective: string; // "AND" | "OR"
  status: string;
  survivedScrutiny: number; // SAFE F1@K-style precision; feeds VD
  verifierModelFamily: string; // MUST differ from author (LD8)
  legible: boolean | null; // P2 telemetry
  pEstimate: number | null; // P2 telemetry — EXPORT ONLY, never enters VD
}

export function makeVerificationRecord(
  partial: Partial<VerificationRecord> & { id: string; insightId: string },
): VerificationRecord {
  return {
    perPremise: [],
    connective: 'AND',
    status: InsightStatus.UNVERIFIABLE,
    survivedScrutiny: 0,
    verifierModelFamily: 'unknown',
    legible: null,
    pEstimate: null,
    ...partial,
  };
}

// A distilled, validated innovation key-point (R3 / P8).
export interface KeyPoint {
  id: string;
  text: string;
  prevalence: number; // KPA cluster size (matched insights)
  originTurns: string[];
  verificationId: string | null;
  survivingChallenges: string[]; // move ids
  originality: number; // SEPARATE rankings (P8)
  feasibility: number;
  novelty: number;
  tier: string;
}

export function makeKeyPoint(partial: Partial<KeyPoint> & { id: string; text: string }): KeyPoint {
  return {
    prevalence: 1,
    originTurns: [],
    verificationId: null,
    survivingChallenges: [],
    originality: 0,
    feasibility: 0,
    novelty: 0,
    tier: KeyPointTier.VALIDATED,
    ...partial,
  };
}

// Audited capture recall + coverage telemetry (R1 / LD5 / §7.13).
export interface CoverageReport {
  kTarget: number | null;
  capturedUnionCount: number;
  coverage: number;
  omissionPassCount: number;
  estimatedRecall: number | null; // P2 telemetry (capture–recapture)
  goldSetRecall: number | null; // the ONE honest number (M4)
}

export function makeCoverageReport(partial?: Partial<CoverageReport>): CoverageReport {
  return {
    kTarget: null,
    capturedUnionCount: 0,
    coverage: 0,
    omissionPassCount: 0,
    estimatedRecall: null,
    goldSetRecall: null,
    ...partial,
  };
}

// Overlapping-but-distinct per-agent knowledge (P10).
export interface KnowledgePacket {
  forA: string;
  forB: string;
  sharedCore: string;
  overlapRatio: number;
}

export function makeKnowledgePacket(partial?: Partial<KnowledgePacket>): KnowledgePacket {
  return { forA: '', forB: '', sharedCore: '', overlapRatio: DEFAULT_OVERLAP_RATIO, ...partial };
}

// ---------------------------------------------------------------------------
// Audit + intervention
// ---------------------------------------------------------------------------

export interface Violation {
  kind: string; // "injection" | "caved_without_evidence" | "verifier_family_mismatch" | ...
  description: string;
  disqualifying: boolean;
  roundNumber: number | null;
  actor: string | null;
}

export function makeViolation(partial: Partial<Violation> & { kind: string }): Violation {
  return { description: '', disqualifying: false, roundNumber: null, actor: null, ...partial };
}

export interface MonitorReport {
  keyPoints: string[];
  violations: Violation[];
  converging: boolean;
  notes: string;
}

export function makeMonitorReport(partial?: Partial<MonitorReport>): MonitorReport {
  return { keyPoints: [], violations: [], converging: false, notes: '', ...partial };
}

export interface AuditEvent {
  action: string;
  phase: string;
  actor: string; // system | judge | agent_a | agent_b | human
  description: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  timestamp: Date;
}

export function makeAuditEvent(partial: Partial<AuditEvent> & { action: string }): AuditEvent {
  return {
    phase: Phase.CONFIG,
    actor: 'system',
    description: '',
    before: null,
    after: null,
    reason: null,
    timestamp: new Date(),
    ...partial,
  };
}

export interface ScoreAdjustment {
  roundNumber: number;
  originalA: number;
  originalB: number;
  adjustedA: number;
  adjustedB: number;
  reason: string;
  timestamp: Date;
}

export function makeScoreAdjustment(
  partial: Partial<ScoreAdjustment> & {
    roundNumber: number;
    originalA: number;
    originalB: number;
    adjustedA: number;
    adjustedB: number;
  },
): ScoreAdjustment {
  return { reason: '', timestamp: new Date(), ...partial };
}

export interface HumanOverride {
  field: string; // "result_type" | "composite" | "complexity_flag"
  original: unknown;
  overridden: unknown;
  reason: string;
  timestamp: Date;
}

export function makeHumanOverride(partial: Partial<HumanOverride> & { field: string }): HumanOverride {
  return { original: null, overridden: null, reason: '', timestamp: new Date(), ...partial };
}

// ---------------------------------------------------------------------------
// Validation report (dryRun) — ARCHITECTURE §8
// ---------------------------------------------------------------------------

export interface ValidationReport {
  configOk: boolean;
  endpointAOk: boolean;
  endpointBOk: boolean;
  judgeEndpointOk: boolean;
  judgeJsonOutputOk: boolean;
  embeddingsEndpointOk: boolean;
  judgeSwapConsistencyOk: boolean;
  searchApisOk: Record<string, unknown>;
  errors: string[];
}

export function makeValidationReport(partial?: Partial<ValidationReport>): ValidationReport {
  return {
    configOk: false,
    endpointAOk: false,
    endpointBOk: false,
    judgeEndpointOk: false,
    judgeJsonOutputOk: false,
    embeddingsEndpointOk: false,
    judgeSwapConsistencyOk: false,
    searchApisOk: {},
    errors: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Lightweight cross-unit summary (maps 1:1 to the SQLite units row)
// ---------------------------------------------------------------------------

export interface UnitSummary {
  unitId: string;
  sessionId: string;
  topic: string;
  agentAName: string;
  agentBName: string;
  timestamp: Date;
  scoreA: number;
  scoreB: number;
  diffNorm: number;
  violationRate: number;
  tailScore: number;
  marginalDiversity: number;
  goodIdeaCount: number;
  judgeReliability: number;
  composite: number;
  disqualified: boolean;
  rigorTier: string;
  swapAgreementRate: number;
  poolEligible: boolean;
  clusterEntropy: number;
  stdSelfInfo: number;
  openingDiversity: number;
  roundsToStability: number;
  // (v2.1)
  captureCoverage: number;
  verificationPassRate: number;
  verifiedDepth: number;
  stdSelfInfoVerified: number;
  validatedKeyPointCount: number;
  candidateInsightCount: number;
  judgeDiscernment: number;
  resultType: string;
  complexityFlag: string;
  humanIntervention: boolean;
  roundCount: number;
  totalTokens: number;
}

export function makeUnitSummary(
  partial: Partial<UnitSummary> & {
    unitId: string;
    sessionId: string;
    topic: string;
    agentAName: string;
    agentBName: string;
    timestamp: Date;
  },
): UnitSummary {
  return {
    scoreA: 0,
    scoreB: 0,
    diffNorm: 0,
    violationRate: 0,
    tailScore: 0,
    marginalDiversity: 0,
    goodIdeaCount: 0,
    judgeReliability: 0,
    composite: 0,
    disqualified: false,
    rigorTier: RigorTier.STANDARD,
    swapAgreementRate: 0,
    poolEligible: false,
    clusterEntropy: 0,
    stdSelfInfo: 0,
    openingDiversity: 0,
    roundsToStability: 0,
    captureCoverage: 0,
    verificationPassRate: 0,
    verifiedDepth: 0,
    stdSelfInfoVerified: 0,
    validatedKeyPointCount: 0,
    candidateInsightCount: 0,
    judgeDiscernment: 0,
    resultType: ResultType.CONTROVERSIAL,
    complexityFlag: ComplexityFlag.NORMAL,
    humanIntervention: false,
    roundCount: 0,
    totalTokens: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// UnitResult (v2.1) — the cell's exported artifact
// ---------------------------------------------------------------------------

export interface UnitResult {
  unitId: string;
  sessionId: string;
  topic: string;
  agentAName: string;
  agentBName: string;
  judgeModel: string;
  timestamp: Date;
  config: Record<string, unknown>;
  conversation: Record<string, unknown>[];
  roundScores: RoundScore[];
  normalized: NormalizedScores;
  weights: WeightVector;
  reliability: ReliabilityStats;
  entropy: EntropyMetrics;
  ideaLedger: IdeaRecord[];
  // (v2.1)
  insights: InsightRecord[];
  verificationRecords: VerificationRecord[];
  validatedKeyPoints: KeyPoint[];
  candidateInsights: InsightRecord[];
  coverageReport: CoverageReport | null;
  judgeDiscernment: number | null; // P2 telemetry
  // bookkeeping
  violations: Violation[];
  auditLog: AuditEvent[];
  scoreAdjustments: ScoreAdjustment[];
  humanOverrides: HumanOverride[];
  resultType: string;
  complexityFlag: string;
  openingDiversity: number;
  roundsToStability: number;
  rigorTier: string;
  humanIntervention: boolean;
  humanJudge: boolean;
  roundCount: number;
  totalTokens: number;
}

export function makeUnitResult(partial?: Partial<UnitResult>): UnitResult {
  return {
    unitId: '',
    sessionId: '',
    topic: '',
    agentAName: 'Agent A',
    agentBName: 'Agent B',
    judgeModel: 'local-judge',
    timestamp: new Date(),
    config: {},
    conversation: [],
    roundScores: [],
    normalized: makeNormalizedScores(),
    weights: makeWeightVector(),
    reliability: makeReliabilityStats(),
    entropy: makeEntropyMetrics(),
    ideaLedger: [],
    insights: [],
    verificationRecords: [],
    validatedKeyPoints: [],
    candidateInsights: [],
    coverageReport: null,
    judgeDiscernment: null,
    violations: [],
    auditLog: [],
    scoreAdjustments: [],
    humanOverrides: [],
    resultType: ResultType.CONTROVERSIAL,
    complexityFlag: ComplexityFlag.NORMAL,
    openingDiversity: 0,
    roundsToStability: 0,
    rigorTier: RigorTier.STANDARD,
    humanIntervention: false,
    humanJudge: false,
    roundCount: 0,
    totalTokens: 0,
    ...partial,
  };
}

// Derived: build the cross-unit summary row from a full result.
export function unitResultToSummary(r: UnitResult): UnitSummary {
  const cov = r.coverageReport;
  const verified = r.insights.filter((i) => VERIFIED_STATUSES.includes(i.status));
  const vpr = r.insights.length ? verified.length / r.insights.length : 0.0;
  return makeUnitSummary({
    unitId: r.unitId,
    sessionId: r.sessionId,
    topic: r.topic,
    agentAName: r.agentAName,
    agentBName: r.agentBName,
    timestamp: r.timestamp,
    scoreA: Math.trunc(r.normalized.vNormA * 1000),
    scoreB: Math.trunc(r.normalized.vNormB * 1000),
    diffNorm: r.normalized.validityDifferential,
    violationRate: r.normalized.violationRate,
    tailScore: r.weights.tailScore ?? 0.0,
    marginalDiversity: r.weights.marginalDiversity ?? 0.0,
    goodIdeaCount: r.weights.goodIdeaCount,
    judgeReliability: r.weights.judgeReliability ?? 0.0,
    composite: r.weights.composite,
    disqualified: r.weights.disqualified,
    rigorTier: r.rigorTier,
    swapAgreementRate: r.reliability.swapWinnerAgreement,
    poolEligible: r.reliability.poolEligible,
    clusterEntropy: r.entropy.clusterEntropy,
    stdSelfInfo: r.entropy.stdSelfInfo,
    openingDiversity: r.openingDiversity,
    roundsToStability: r.roundsToStability,
    captureCoverage: cov ? cov.coverage : 0.0,
    verificationPassRate: vpr,
    verifiedDepth: r.weights.verifiedDepth ?? 0.0,
    stdSelfInfoVerified: r.entropy.stdSelfInfoVerified ?? 0.0,
    validatedKeyPointCount: r.validatedKeyPoints.length,
    candidateInsightCount: r.candidateInsights.length,
    judgeDiscernment: r.judgeDiscernment ?? 0.0,
    resultType: r.resultType,
    complexityFlag: r.complexityFlag,
    humanIntervention: r.humanIntervention,
    roundCount: r.roundCount,
    totalTokens: r.totalTokens,
  });
}

// ---------------------------------------------------------------------------
// Pure classification (ARCHITECTURE §4.4) — centralised so the threshold
// boundaries are testable and reused by engine/judge.
// ---------------------------------------------------------------------------

// result_type from validity differential; complexity from generativity (P6/P14).
export function classifyResult(
  validityDifferential: number,
  goodIdeaCountNorm: number,
  stdSelfInfo = 0.0,
  sigmaHi: number = DEFAULT_SIGMA_HI,
): [ResultType, ComplexityFlag] {
  let resultType: ResultType;
  if (validityDifferential >= 0.6) {
    resultType = ResultType.DECISIVE;
  } else if (validityDifferential >= 0.3) {
    resultType = ResultType.TILTED;
  } else {
    resultType = ResultType.CONTROVERSIAL;
  }

  let complexity: ComplexityFlag;
  if (goodIdeaCountNorm >= 0.6 || stdSelfInfo >= sigmaHi) {
    complexity = ComplexityFlag.HIGH;
  } else if (goodIdeaCountNorm <= 0.2) {
    complexity = ComplexityFlag.LOW;
  } else {
    complexity = ComplexityFlag.NORMAL;
  }
  return [resultType, complexity];
}

export function clamp01(x: number): number {
  return x < 0.0 ? 0.0 : x > 1.0 ? 1.0 : x;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// "session-YYYYMMDD-HHMMSS-<6 hex>" — UTC, matching the Python strftime layout.
export function createSessionId(): string {
  const d = new Date();
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return `session-${stamp}-${randomHex(6)}`;
}

function randomHex(n: number): string {
  // node:crypto used lazily so this module stays import-light for type-only consumers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(Math.ceil(n / 2))
    .toString('hex')
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// JSON (de)serialisation helpers. The TS records are already plain objects, so
// to/from JSON mostly handles Date <-> ISO string round-tripping for nested
// timestamp fields (AuditEvent, ScoreAdjustment, HumanOverride, UnitSummary,
// UnitResult). enums are plain string unions => already JSON-safe.
// ---------------------------------------------------------------------------

export function toJsonable(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === 'boolean' || typeof obj === 'number' || typeof obj === 'string') {
    return obj;
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => toJsonable(v));
  }
  if (obj instanceof Set) {
    return Array.from(obj).map((v) => toJsonable(v));
  }
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = toJsonable(v);
    }
    return out;
  }
  return String(obj);
}

// Revive ISO timestamps for the known Date-bearing fields, recursively.
const DATE_FIELDS: ReadonlySet<string> = new Set(['timestamp']);

export function fromJsonable<T>(data: unknown): T {
  return reviveDates(data) as T;
}

function reviveDates(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((v) => reviveDates(v));
  }
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (DATE_FIELDS.has(k) && typeof v === 'string') {
        out[k] = new Date(v);
      } else {
        out[k] = reviveDates(v);
      }
    }
    return out;
  }
  return data;
}
