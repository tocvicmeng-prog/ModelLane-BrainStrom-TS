// config.ts (N2) — Configuration validation.
//
// validateConfig returns a list of findings (errors + warnings); it never throws,
// so a caller can surface every problem at once. Includes rigor-tier /
// overlap-ratio / embeddings-endpoint checks and a projected-judge-spend warning;
// the spend warning is split into separate judgeSpend and harvestVerifySpend
// findings so neither masks the other (CONSTITUTION §5).

import {
  JudgeMode,
  RigorTier,
  UnitConfig,
  ValidationError,
  makeUnitConfig,
  makeValidationError,
  scoringScaleIsValid,
  validationErrorIsError,
} from './types';

// Default, valid configuration (DEFAULT_CONFIG export).
export const DEFAULT_CONFIG: UnitConfig = makeUnitConfig();

// Rough projection constants (heuristic, used only to decide whether to WARN).
const JUDGE_CALLS_PER_ROUND: Record<RigorTier, number> = {
  [RigorTier.ECONOMY]: 1,
  [RigorTier.STANDARD]: 2,
  [RigorTier.HIGH_STAKES]: 6,
};
const EST_TOKENS_PER_JUDGE_CALL = 1500;
const EST_TOKENS_PER_HARVEST_ROUND = 1200;
const EST_TOKENS_PER_VERIFY = 900;
const SPEND_WARN_FRACTION = 0.4;

// Coerce a value to a known RigorTier, or null if unrecognized.
function tier(value: RigorTier | string): RigorTier | null {
  return (Object.values(RigorTier) as string[]).includes(value)
    ? (value as RigorTier)
    : null;
}

// True if the value is a recognized JudgeMode.
function modeOk(value: JudgeMode | string): boolean {
  return (Object.values(JudgeMode) as string[]).includes(value);
}

export function validateConfig(config: UnitConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // -- endpoints + models ---------------------------------------------
  for (const [label, ac] of [
    ['agent_a', config.agentA],
    ['agent_b', config.agentB],
  ] as const) {
    if (!ac.endpoint.trim()) {
      errors.push(makeValidationError({ field: label, message: `${label}.endpoint must not be empty` }));
    }
    if (!ac.model.trim()) {
      errors.push(makeValidationError({ field: label, message: `${label}.model is required` }));
    }
  }
  if (!config.judge.endpoint.trim()) {
    errors.push(makeValidationError({ field: 'judge', message: 'judge.endpoint must not be empty' }));
  }
  if (!config.judge.model.trim()) {
    errors.push(makeValidationError({ field: 'judge', message: 'judge.model is required' }));
  }
  if (!config.embeddings.endpoint.trim()) {
    errors.push(makeValidationError({ field: 'embeddings', message: 'embeddings.endpoint must not be empty' }));
  }

  // -- numeric bounds --------------------------------------------------
  if (config.tokenBudget <= 0) {
    errors.push(makeValidationError({ field: 'token_budget', message: 'token_budget must be > 0' }));
  }
  if (config.maxRounds < 1) {
    errors.push(makeValidationError({ field: 'max_rounds', message: 'max_rounds must be >= 1' }));
  }
  if (config.agentTimeout <= 0) {
    errors.push(makeValidationError({ field: 'agent_timeout', message: 'agent_timeout must be > 0' }));
  }
  if (!(config.overlapRatio > 0.0 && config.overlapRatio < 1.0)) {
    errors.push(makeValidationError({ field: 'overlap_ratio', message: 'overlap_ratio must be in (0, 1)' }));
  }

  // -- scoring scale invariant (win > draw >= loss) -------------------
  if (!scoringScaleIsValid(config.scoringScale)) {
    errors.push(makeValidationError({ field: 'scoring_scale', message: 'scoring_scale must satisfy win > draw >= loss' }));
  }

  // -- enums -----------------------------------------------------------
  if (tier(config.rigorTier) === null) {
    errors.push(makeValidationError({ field: 'rigor_tier', message: `unknown rigor_tier: ${reprStr(config.rigorTier)}` }));
  }
  if (!modeOk(config.judgeMode)) {
    errors.push(makeValidationError({ field: 'judge_mode', message: `unknown judge_mode: ${reprStr(config.judgeMode)}` }));
  }

  // -- projected spend warnings (CONSTITUTION §5) ---------------------
  const t = tier(config.rigorTier) ?? RigorTier.STANDARD;
  if (config.tokenBudget > 0) {
    const judgeProj = JUDGE_CALLS_PER_ROUND[t] * config.maxRounds * EST_TOKENS_PER_JUDGE_CALL;
    if (judgeProj > SPEND_WARN_FRACTION * config.tokenBudget) {
      errors.push(makeValidationError({
        field: 'judge_spend',
        message:
          `projected judge spend (~${judgeProj} tok) exceeds ` +
          `${Math.trunc(SPEND_WARN_FRACTION * 100)}% of the token budget`,
        severity: 'warning',
      }));
    }

    // Harvest runs per round; verify is event-triggered (estimate ~1 per round).
    let hvProj = config.maxRounds * (EST_TOKENS_PER_HARVEST_ROUND + EST_TOKENS_PER_VERIFY);
    if (t === RigorTier.ECONOMY) {
      hvProj = config.maxRounds * EST_TOKENS_PER_HARVEST_ROUND; // capture only, no verify
    }
    if (hvProj > SPEND_WARN_FRACTION * config.tokenBudget) {
      errors.push(makeValidationError({
        field: 'harvest_verify_spend',
        message:
          `projected harvest+verify spend (~${hvProj} tok) exceeds ` +
          `${Math.trunc(SPEND_WARN_FRACTION * 100)}% of the token budget`,
        severity: 'warning',
      }));
    }
  }

  return errors;
}

// True if any finding is a hard error (warnings do not block a run).
export function hasBlockingErrors(findings: ValidationError[]): boolean {
  return findings.some((f) => validationErrorIsError(f));
}

// Mimic Python's repr() of a string value for unknown-enum messages: 'value'.
function reprStr(value: string): string {
  return `'${value}'`;
}
