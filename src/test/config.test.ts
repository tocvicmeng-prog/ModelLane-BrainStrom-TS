// Ported from python/tests/test_config.py (N2).
// validateConfig returns findings (never throws); hasBlockingErrors reports hard errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, hasBlockingErrors, validateConfig } from '../engine/config';
import {
  RigorTier,
  ScoringScale,
  UnitConfig,
  ValidationError,
  makeAgentConfig,
  makeScoringScale,
  makeUnitConfig,
  validationErrorIsError,
} from '../engine/types';

// Mirror of the pytest `_errors` helper: keep only hard-error findings.
function errors(findings: ValidationError[]): ValidationError[] {
  return findings.filter((f) => validationErrorIsError(f));
}

test('test_default_config_valid', () => {
  const findings = validateConfig(DEFAULT_CONFIG);
  assert.deepEqual(errors(findings), []); // no hard errors on defaults
  assert.equal(hasBlockingErrors(findings), false);
});

test('test_invalid_budget_flagged', () => {
  for (const bad of [0, -1]) {
    const findings = validateConfig(makeUnitConfig({ tokenBudget: bad }));
    assert.ok(findings.some((f) => f.field === 'token_budget' && validationErrorIsError(f)));
  }
});

test('test_invalid_max_rounds', () => {
  const findings = validateConfig(makeUnitConfig({ maxRounds: 0 }));
  assert.ok(findings.some((f) => f.field === 'max_rounds' && validationErrorIsError(f)));
});

test('test_invalid_scoring_scale', () => {
  const scale: ScoringScale = makeScoringScale({ win: 1, draw: 1, loss: 0 });
  const findings = validateConfig(makeUnitConfig({ scoringScale: scale }));
  assert.ok(findings.some((f) => f.field === 'scoring_scale' && validationErrorIsError(f)));
});

test('test_empty_endpoint_flagged', () => {
  const cfg: UnitConfig = makeUnitConfig({
    agentA: makeAgentConfig({ name: 'A', endpoint: '', model: 'm', modelFamily: 'fa' }),
  });
  const findings = validateConfig(cfg);
  assert.ok(findings.some((f) => f.field === 'agent_a' && validationErrorIsError(f)));
});

test('test_overlap_ratio_range', () => {
  assert.ok(
    validateConfig(makeUnitConfig({ overlapRatio: 0.0 })).some((f) => f.field === 'overlap_ratio'),
  );
  assert.ok(
    validateConfig(makeUnitConfig({ overlapRatio: 1.0 })).some((f) => f.field === 'overlap_ratio'),
  );
  assert.ok(
    !validateConfig(makeUnitConfig({ overlapRatio: 0.5 })).some((f) => f.field === 'overlap_ratio'),
  );
});

test('test_invalid_rigor_tier', () => {
  const cfg = makeUnitConfig();
  // Force an invalid tier value (mirrors `cfg.rigor_tier = "turbo"`).
  (cfg as { rigorTier: RigorTier }).rigorTier = 'turbo' as unknown as RigorTier;
  assert.ok(
    validateConfig(cfg).some((f) => f.field === 'rigor_tier' && validationErrorIsError(f)),
  );
});

test('test_judge_spend_warning_fires_on_tiny_budget', () => {
  const cfg = makeUnitConfig({
    tokenBudget: 1000,
    maxRounds: 8,
    rigorTier: RigorTier.STANDARD,
  });
  const findings = validateConfig(cfg);
  const warns = findings.filter((f) => f.field === 'judge_spend');
  assert.ok(warns.length > 0);
  assert.equal(warns[0].severity, 'warning');
  assert.equal(validationErrorIsError(warns[0]), false); // a warning never blocks
});

test('test_harvest_verify_spend_warning_is_separate', () => {
  const cfg = makeUnitConfig({
    tokenBudget: 1000,
    maxRounds: 8,
    rigorTier: RigorTier.STANDARD,
  });
  const findings = validateConfig(cfg);
  const fields = new Set(findings.map((f) => f.field));
  // Both spend warnings present and independent (neither masks the other).
  assert.ok(fields.has('judge_spend'));
  assert.ok(fields.has('harvest_verify_spend'));
});

test('test_warnings_do_not_block', () => {
  const cfg = makeUnitConfig({ tokenBudget: 1000, maxRounds: 8 }); // triggers spend warnings only
  const findings = validateConfig(cfg);
  assert.equal(hasBlockingErrors(findings), false);
});
