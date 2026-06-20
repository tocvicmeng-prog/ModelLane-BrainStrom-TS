// Regression tests for the 3rd-party audit hardening (F1, F3, F8, F9).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeGuardedFetch,
  RESEARCH_ALLOWLIST,
  EgressError,
  assertResolvedHostSafe,
} from '../orchestrator/connectors/egress';
import { buildResearch } from '../orchestrator/groupRunner';
import { KnowledgeEngine } from '../engine/research';
import { NoopKnowledgeEngine } from '../orchestrator/security';
import { EmbeddingsClient } from '../engine/embeddings';
import { BaseConnector } from '../orchestrator/connectors/base';
import { validateConfig } from '../brainstorm/configValidation';
import { CliAgentClient } from '../orchestrator/connectors/cli';
import * as fs from 'node:fs';

// ---- F1: research-enabled sessions cannot bypass the egress guard --------------------
test('F1: research egress guard blocks non-research / metadata / model-API hosts', async () => {
  const trap: any = () => {
    throw new Error('RAW research fetch reached the network — egress bypass!');
  };
  const guarded = makeGuardedFetch(trap, true, RESEARCH_ALLOWLIST);
  // Each rejects at validateEgress BEFORE the inner fetch (trap never runs).
  await assert.rejects(() => guarded('https://evil.example.com/x') as any, EgressError);
  await assert.rejects(() => guarded('http://169.254.169.254/latest/meta-data/') as any, EgressError);
  await assert.rejects(() => guarded('https://api.openai.com/v1') as any, EgressError); // not a research host
  await assert.rejects(() => guarded('http://en.wikipedia.org/w/api.php') as any, EgressError); // research host must be https
});

test('F1: buildResearch is Noop when off and a KnowledgeEngine when on', () => {
  assert.ok(buildResearch(false) instanceof NoopKnowledgeEngine);
  assert.ok(buildResearch(true) instanceof KnowledgeEngine);
});

// ---- F3: embeddings cache never defaults to a relative ./data path -------------------
test('F3: EmbeddingsClient with no cacheDir caches in-memory only (cacheDir = null)', () => {
  const c = new EmbeddingsClient({ mockVectors: {} });
  assert.equal(c.cacheDir, null);
});

test('F3: connector-built embeddings client never defaults to a relative cache path', () => {
  const conn = new BaseConnector('local', 'http://localhost:1234/v1', {});
  assert.equal(conn.makeEmbeddingsClient({}).cacheDir, null);
  assert.equal(conn.makeEmbeddingsClient({ cacheDir: '/abs/global/embeddings' }).cacheDir, '/abs/global/embeddings');
});

// ---- F8: admin config validation -----------------------------------------------------
test('F8: validateConfig accepts a valid config and flags malformed ones', () => {
  const good = {
    connectors: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }],
    seats: {
      agent_a: { connectorId: 'local', model: 'm', family: 'a' },
      agent_b: { connectorId: 'local', model: 'm', family: 'b' },
      judge: { connectorId: 'local', model: 'm', family: 'j' },
    },
    mode: 'mixed', maxPoints: 5, researchEnabled: false,
  };
  assert.deepEqual(validateConfig(good), []);

  assert.ok(validateConfig({ ...good, connectors: [{ id: 'x', kind: 'bogus', baseUrl: 'http://localhost/v1' }] })
    .some((p) => /unknown kind/.test(p)));
  assert.ok(validateConfig({ ...good, connectors: [{ id: '', kind: 'openai-compatible', baseUrl: 'http://localhost/v1' }] })
    .some((p) => /empty id/.test(p)));
  assert.ok(validateConfig({ ...good, connectors: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'not a url' }] })
    .some((p) => /invalid base url/.test(p)));
  assert.ok(validateConfig({ ...good, seats: { ...good.seats, judge: { connectorId: 'local', model: '', family: 'j' } } })
    .some((p) => /no model/.test(p)));
  assert.ok(validateConfig({ ...good, mode: 'nope' }).some((p) => /debate mode/.test(p)));
  assert.ok(validateConfig({ ...good, maxPoints: 99 }).some((p) => /max points/.test(p)));
  assert.ok(validateConfig({ ...good, seats: { ...good.seats, agent_a: { connectorId: 'ghost', model: 'm', family: 'a' } } })
    .some((p) => /unknown connector/.test(p)));
  assert.ok(validateConfig({ connectors: [{ id: 'c', kind: 'cli' }], seats: good.seats }).some((p) => /needs a command/.test(p)));
});

// ---- F9: DNS-rebinding recheck skips literals / localhost (no network in tests) -------
test('F9: assertResolvedHostSafe skips literal IPs and localhost without throwing', async () => {
  await assertResolvedHostSafe('http://127.0.0.1:1234/v1');
  await assertResolvedHostSafe('http://localhost:1234/v1');
  await assertResolvedHostSafe('http://[::1]:1234/v1');
  await assertResolvedHostSafe('https://8.8.8.8/'); // literal public IP — classified by validateEgress, not re-resolved
});

// ---- F2: CLI runs in an isolated throwaway cwd when allowFileTools is off ------------
test('F2: CLI (allowFileTools=false) runs in a fresh temp cwd that is cleaned up', async () => {
  // The CLI just prints its own cwd; with allowFileTools off it must be a throwaway
  // brainstrom-cli-* temp dir, different per call, and removed afterward.
  const mk = () =>
    new CliAgentClient({
      command: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
      model: 'm',
      allowFileTools: false,
    });
  const cwd1 = (await mk().speak([{ role: 'user', content: 'x' }])).trim();
  const cwd2 = (await mk().speak([{ role: 'user', content: 'x' }])).trim();
  assert.match(cwd1, /brainstrom-cli-/);
  assert.notEqual(cwd1, cwd2); // a fresh isolated dir per call
  assert.ok(!fs.existsSync(cwd1)); // removed after the call (best-effort cleanup)
});
