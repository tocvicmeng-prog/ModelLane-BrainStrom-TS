// Ported from python/tests/test_budget.py
// N3 — Pure arithmetic; phase envelopes; fallback estimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BudgetTracker } from '../engine/budget';

test('test_initial_state', () => {
  const b = new BudgetTracker(1000);
  assert.equal(b.pctUsed(), 0.0);
  assert.equal(b.shouldWarn75(), false);
  assert.equal(b.shouldWarn95(), false);
  assert.equal(b.isExhausted(), false);
  assert.equal(b.grandTotal, 0);
});

test('test_zero_or_negative_budget_raises', () => {
  assert.throws(() => new BudgetTracker(0));
  assert.throws(() => new BudgetTracker(-5));
});

test('test_agent_usage_accumulates', () => {
  const b = new BudgetTracker(10_000);
  b.addAgentUsage(100, 50, 'propose');
  b.addAgentUsage(200, 100, 'propose');
  b.addAgentUsage(10, 5, 'clash');
  assert.equal(b.agentTotal, 465);
  assert.equal(b.phaseTotal['propose'], 450);
  assert.equal(b.phaseTotal['clash'], 15);
});

test('test_judge_and_harvest_tracked_separately', () => {
  const b = new BudgetTracker(10_000);
  b.addAgentUsage(100, 0, 'clash');
  b.addJudgeUsage(200, 0, 'clash');
  b.addHarvestVerifyUsage(50, 0, 'clash');
  assert.equal(b.agentTotal, 100);
  assert.equal(b.judgeTotal, 200);
  assert.equal(b.harvestVerifyTotal, 50);
  assert.equal(b.grandTotal, 350); // all three buckets sum into the total
});

test('test_warn_75_fires_once', () => {
  const b = new BudgetTracker(1000);
  b.addAgentUsage(750, 0, 'clash');
  assert.equal(b.shouldWarn75(), true);
  assert.equal(b.shouldWarn75(), false); // latched
  assert.equal(b.shouldWarn95(), false);
});

test('test_warn_95_fires_once', () => {
  const b = new BudgetTracker(1000);
  b.addAgentUsage(950, 0, 'clash');
  assert.equal(b.shouldWarn95(), true);
  assert.equal(b.shouldWarn95(), false);
});

test('test_exhausted_at_limit', () => {
  const b = new BudgetTracker(1000);
  b.addAgentUsage(1000, 0, 'clash');
  assert.equal(b.isExhausted(), true);
  assert.equal(b.pctUsed(), 1.0);
});

test('test_phase_envelope_exhaustion_forces_transition', () => {
  const b = new BudgetTracker(1000); // propose envelope = 40% = 400
  b.addAgentUsage(399, 0, 'propose');
  assert.equal(b.phaseExhausted('propose'), false);
  b.addAgentUsage(1, 0, 'propose');
  assert.equal(b.phaseExhausted('propose'), true);
  assert.equal(b.phaseExhausted('clash'), false); // independent envelope
  assert.equal(b.phaseExhausted('unknown_phase'), false);
});

test('test_fallback_estimation', () => {
  assert.equal(BudgetTracker.estimateTokens(''), 0);
  assert.equal(BudgetTracker.estimateTokens('abcd'), 2); // 4 chars // 2
  assert.equal(BudgetTracker.estimateTokens('a'.repeat(100)), 50);
});

test('test_edge_budget_one', () => {
  const b = new BudgetTracker(1);
  assert.equal(b.isExhausted(), false);
  b.addJudgeUsage(1, 0, 'clash');
  assert.equal(b.isExhausted(), true);
});
