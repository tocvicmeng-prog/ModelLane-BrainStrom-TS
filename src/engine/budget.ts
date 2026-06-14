// budget.ts (N3) — Token budget tracking with per-phase envelopes.
//
// Tracks three spend buckets — debate agents, the Judge, and (v2.1) the
// harvest+verify subsystem — against a single token ceiling. Per-phase envelopes
// bound spend within OPEN/PROPOSE/CLASH/RECOMMEND; exhausting an envelope forces a
// PHASE TRANSITION (not session end). Global 75/95/100% behaviour is unchanged.
//
// See ARCHITECTURE.md §4.5–4.6 and CONSTITUTION.md §5 (Budget Monitoring).

export class BudgetTracker {
  // Debate-phase envelopes as a fraction of the limit (+0.05 reserve). Prep
  // phases (research/study/inject) are logged but excluded from the debate budget.
  static readonly PHASE_ENVELOPE: Readonly<Record<string, number>> = {
    open: 0.05,
    propose: 0.4,
    clash: 0.35,
    recommend: 0.15,
  };

  readonly limit: number;
  agentTotal = 0;
  judgeTotal = 0;
  harvestVerifyTotal = 0; // (v2.1) capture + verification spend
  phaseTotal: Record<string, number> = {};
  private warned75 = false;
  private warned95 = false;

  constructor(limit: number) {
    if (limit <= 0) {
      throw new Error(`budget limit must be positive, got ${limit}`);
    }
    this.limit = limit;
  }

  // -- usage accumulation ----------------------------------------------
  addAgentUsage(prompt: number, completion: number, phase = 'propose'): void {
    const total = prompt + completion;
    this.agentTotal += total;
    this.phaseTotal[phase] = (this.phaseTotal[phase] ?? 0) + total;
  }

  addJudgeUsage(prompt: number, completion: number, phase = 'clash'): void {
    const total = prompt + completion;
    this.judgeTotal += total;
    this.phaseTotal[phase] = (this.phaseTotal[phase] ?? 0) + total;
  }

  // (v2.1) Capture/verification spend — tracked separately so the
  // `harvestVerifySpend` config warning never hides behind judge spend.
  addHarvestVerifyUsage(prompt: number, completion: number, phase = 'clash'): void {
    const total = prompt + completion;
    this.harvestVerifyTotal += total;
    this.phaseTotal[phase] = (this.phaseTotal[phase] ?? 0) + total;
  }

  // -- queries ----------------------------------------------------------
  get grandTotal(): number {
    return this.agentTotal + this.judgeTotal + this.harvestVerifyTotal;
  }

  pctUsed(): number {
    return this.grandTotal / this.limit;
  }

  // True when this phase's envelope is spent — forces a phase transition.
  phaseExhausted(phase: string): boolean {
    const env = BudgetTracker.PHASE_ENVELOPE[phase];
    if (env === undefined) {
      return false;
    }
    return (this.phaseTotal[phase] ?? 0) >= env * this.limit;
  }

  shouldWarn75(): boolean {
    if (!this.warned75 && this.pctUsed() >= 0.75) {
      this.warned75 = true;
      return true;
    }
    return false;
  }

  shouldWarn95(): boolean {
    if (!this.warned95 && this.pctUsed() >= 0.95) {
      this.warned95 = true;
      return true;
    }
    return false;
  }

  isExhausted(): boolean {
    return this.grandTotal >= this.limit;
  }

  // Fallback when a provider omits `usage`: ~2 chars/token (CJK-aware).
  static estimateTokens(text: string): number {
    return Math.max(0, Math.floor(text.length / 2));
  }
}
