// Ported from python/tests/test_bs_egress.py (N4).
// Egress guard: loopback-default, allowlist, https, metadata block (S4/S5).
// validateEgress throws EgressError on a policy violation; allow_remote -> positional allowRemote.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EgressError, validateEgress } from '../orchestrator/connectors/egress';

test('test_local_endpoints_allowed', () => {
  // Local hosts are allowed by default (no throw).
  validateEgress('http://localhost:1234/v1');
  validateEgress('http://127.0.0.1:8080/v1');
  validateEgress('http://192.168.1.50:1234/v1'); // private range
  validateEgress('http://[::1]:1234/v1'); // ipv6 loopback
});

test('test_remote_blocked_without_optin', () => {
  assert.throws(() => validateEgress('https://api.openai.com/v1'), EgressError);
});

test('test_remote_allowed_with_optin_and_allowlist', () => {
  validateEgress('https://api.openai.com/v1', true);
  validateEgress('https://api.anthropic.com/v1', true);
});

test('test_remote_not_in_allowlist_blocked', () => {
  assert.throws(() => validateEgress('https://evil.example.com/v1', true), EgressError);
});

test('test_remote_requires_https', () => {
  assert.throws(() => validateEgress('http://api.anthropic.com/v1', true), EgressError);
});

test('test_cloud_metadata_always_blocked', () => {
  assert.throws(() => validateEgress('http://169.254.169.254/latest/meta-data/'), EgressError);
});
