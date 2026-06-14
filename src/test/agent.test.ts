// agent.test.ts — STRICT-TS port of python/tests/test_agent.py.
//
// Mirrors the pytest one-for-one: each pytest function maps to one node:test
// test(). Python monkeypatched `requests.post`; here we inject a fake
// `fetchImpl: FetchLike` (and a no-op `sleepImpl` so retry backoff never waits)
// into AgentClient. Zero network, zero subprocess, zero tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentClient, type AgentClientOptions } from '../engine/agent';
import { MoveType, type ChatMessage } from '../engine/types';
import type { FetchLike } from '../engine/http';

// --- fake HTTP plumbing ----------------------------------------------------

interface ChatPayload {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

function chatPayload(content: string, promptTokens = 10, completionTokens = 5): ChatPayload {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// A minimal Response-like; mirrors the Python FakeResp (.json()/raise_for_status
// surface) but shaped for the FetchLike/fetchJson contract (ok/status/json/text).
function fakeResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

const noopSleep = async (_ms: number): Promise<void> => {};

// Build a client wired with injected fetch + no-op sleep (so backoff is instant).
function makeClient(
  partial: Partial<AgentClientOptions> & { fetchImpl?: FetchLike },
): AgentClient {
  return new AgentClient({
    endpoint: 'http://x/v1',
    model: 'm',
    sleepImpl: noopSleep,
    ...partial,
  });
}

// Subclass exposing the protected buildMessages() — the pytest calls the private
// `client._build_messages(...)` directly in test_inject_context_format.
class ProbeAgentClient extends AgentClient {
  publicBuildMessages(conversation: ChatMessage[]): ChatMessage[] {
    return this.buildMessages(conversation);
  }
}

// ---------------------------------------------------------------------------

test('speak_returns_string', async () => {
  const client = makeClient({ mockResponse: 'hello there' });
  assert.equal(await client.speak([{ role: 'user', content: 'hi' }]), 'hello there');
});

test('mock_mode_makes_no_http', async () => {
  const called = { n: 0 };
  const fetchImpl = (async () => {
    called.n += 1;
    return fakeResponse(200, chatPayload('ignored'));
  }) as unknown as FetchLike;
  const client = makeClient({ mockResponse: 'canned', fetchImpl });
  await client.speak([{ role: 'user', content: 'hi' }]);
  assert.equal(called.n, 0);
});

test('speak_passes_conversation', async () => {
  const captured: { json?: { messages: ChatMessage[] } } = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured.json = JSON.parse(String(init.body)) as { messages: ChatMessage[] };
    return fakeResponse(200, chatPayload('ok'));
  }) as unknown as FetchLike;
  const client = makeClient({ systemPrompt: 'You are A.', fetchImpl });
  const out = await client.speak([{ role: 'user', content: 'debate this' }]);
  assert.equal(out, 'ok');
  const msgs = captured.json!.messages;
  assert.deepEqual(msgs[0], { role: 'system', content: 'You are A.' });
  assert.ok(msgs.some((m) => m.content === 'debate this'));
  assert.deepEqual(client.lastUsage, { prompt: 10, completion: 5 });
});

test('inject_context_format', () => {
  const client = new ProbeAgentClient({ endpoint: 'http://x/v1', model: 'm', systemPrompt: 'sys' });
  client.injectContext('packet facts here');
  const msgs = client.publicBuildMessages([{ role: 'user', content: 'q' }]);
  const bg = msgs.filter((m) => m.role === 'system' && m.content.includes('BACKGROUND KNOWLEDGE'));
  assert.ok(bg.length > 0);
  assert.ok(bg[0].content.includes('packet facts here'));
});

test('count_tokens_estimate', () => {
  const client = makeClient({});
  const n = client.countTokens('hello world');
  assert.ok(n >= 1 && n <= 'hello world'.length);
});

test('timeout_raises_connectionerror', async () => {
  // Python raised ConnectionError; the TS port collapses network/timeout into a
  // thrown Error (see agent.chat()), so we assert it rejects.
  const fetchImpl = (async () => {
    throw new Error('unreachable');
  }) as unknown as FetchLike;
  const client = makeClient({ maxRetries: 1, retryBackoff: 0.0, fetchImpl });
  await assert.rejects(() => client.speak([{ role: 'user', content: 'hi' }]));
});

test('retry_on_5xx_then_success', async () => {
  const seq: Response[] = [fakeResponse(503, {}), fakeResponse(200, chatPayload('recovered'))];
  const fetchImpl = (async () => {
    const next = seq.shift();
    if (next === undefined) {
      throw new Error('no more queued responses');
    }
    return next;
  }) as unknown as FetchLike;
  const client = makeClient({ maxRetries: 2, retryBackoff: 0.0, fetchImpl });
  assert.equal(await client.speak([{ role: 'user', content: 'hi' }]), 'recovered');
  assert.equal(seq.length, 0);
});

test('request_slips_parses_json', async () => {
  const payload = JSON.stringify([
    { text: 'Idea one about catalysis' },
    { text: 'Idea two', build_on: 'idea-xyz' },
    { text: 'Idea three' },
  ]);
  const client = makeClient({
    mockResponse: payload,
    agentLabel: 'A',
    modelFamily: 'fam-a',
  });
  const slips = await client.requestSlips('give slips', 2);
  assert.equal(slips.length, 3);
  assert.equal(slips[0].agent, 'A');
  assert.equal(slips[0].roundNumber, 2);
  assert.equal(slips[0].modelFamily, 'fam-a');
  assert.equal(slips[0].harvestedFrom, 'slip');
  assert.deepEqual(slips[1].parentIds, ['idea-xyz']);
});

test('request_slips_fallback_on_prose', async () => {
  const client = makeClient({ mockResponse: '- first idea\n- second idea' });
  const slips = await client.requestSlips('go');
  assert.deepEqual(
    slips.map((s) => s.text),
    ['first idea', 'second idea'],
  );
});

test('request_slips_truncates_to_50_words', async () => {
  const longText = Array.from({ length: 80 }, () => 'w').join(' ');
  const client = makeClient({ mockResponse: JSON.stringify([{ text: longText }]) });
  const slips = await client.requestSlips('go');
  assert.equal(slips[0].text.split(/\s+/).length, 50);
});

test('request_move_parses', async () => {
  const payload = JSON.stringify({
    move_type: 'REBUT',
    target_id: 'move-1',
    content: 'That premise fails.',
  });
  const client = makeClient({ mockResponse: payload, agentLabel: 'B' });
  const move = await client.requestMove('respond', 3);
  assert.equal(move.moveType, MoveType.REBUT);
  assert.equal(move.targetId, 'move-1');
  assert.equal(move.agent, 'B');
  assert.equal(move.roundNumber, 3);
});

test('request_move_fallback_to_claim', async () => {
  const client = makeClient({ mockResponse: 'just some freeform text' });
  const move = await client.requestMove('respond');
  assert.equal(move.moveType, MoveType.CLAIM);
  assert.ok(move.content.includes('freeform'));
});
