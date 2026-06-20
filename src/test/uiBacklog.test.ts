// uiBacklog.test.ts — regression coverage for the v0.6.1 UI backlog:
//   * probeConnector (P0-1): CLI checks are local; remote probes honor the egress guard.
//   * validateConfigDetailed (P0-2): structured problems carry the right field paths, and the
//     legacy string[] view still equals the messages.
// Zero network: the remote-probe cases are rejected by validateEgress BEFORE any request leaves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeConnector } from '../orchestrator/connectors/probe';
import { validateConfig, validateConfigDetailed } from '../brainstorm/configValidation';

test('probe: empty CLI command is rejected locally', async () => {
  const r = await probeConnector({ id: 'x', kind: 'cli', baseUrl: '' } as any, null, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /empty/i);
});

test('probe: a CLI not on PATH reports not-found (no hang)', async () => {
  const r = await probeConnector({ id: 'x', kind: 'cli', baseUrl: '', command: 'definitely-not-a-real-cli-xyzzy' } as any, null, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /not found|launch/i);
});

test('probe: a remote endpoint with allowRemote off is blocked by egress (no network)', async () => {
  const r = await probeConnector({ id: 'o', kind: 'openai', baseUrl: 'https://api.openai.com/v1' } as any, null, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /egress|allowremote/i);
});

test('probe: a non-allowlisted remote host is blocked even with allowRemote on (no network)', async () => {
  const r = await probeConnector({ id: 'o', kind: 'openai', baseUrl: 'https://evil.example.com/v1' } as any, null, true);
  assert.equal(r.ok, false);
  assert.match(r.detail, /egress|allowlist/i);
});

test('validateConfigDetailed maps each problem to a field path', () => {
  const cfg = {
    connectors: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'not a url' }],
    seats: {
      agent_a: { connectorId: 'local', model: '' },
      agent_b: { connectorId: 'nope', model: 'm' },
      judge: { connectorId: 'local', model: 'm' },
    },
    mode: 'bogus', maxPoints: 99, researchEnabled: false,
  };
  const det = validateConfigDetailed(cfg);
  const has = (f: string) => det.some(p => p.field === f);
  assert.ok(has('connectors[0].baseUrl'), 'bad url → connectors[0].baseUrl');
  assert.ok(has('seats.agent_a.model'), 'empty model → seats.agent_a.model');
  assert.ok(has('seats.agent_b.connectorId'), 'unknown connector → seats.agent_b.connectorId');
  assert.ok(has('mode'), 'bad mode → mode');
  assert.ok(has('maxPoints'), 'bad maxPoints → maxPoints');
  // the legacy string[] view is exactly the messages, in order
  assert.deepEqual(validateConfig(cfg), det.map(p => p.message));
});

test('validateConfigDetailed: a valid config yields no problems', () => {
  const cfg = {
    connectors: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }],
    seats: {
      agent_a: { connectorId: 'local', model: 'm' },
      agent_b: { connectorId: 'local', model: 'm' },
      judge: { connectorId: 'local', model: 'm' },
    },
    mode: 'mixed', maxPoints: 5, researchEnabled: false,
  };
  assert.equal(validateConfigDetailed(cfg).length, 0);
});
