// connectors.test.ts — STRICT-TS port of python/tests/test_bs_connectors.py.
//
// Connector tests (N2/N3): client construction, secret hiding, Anthropic chat()
// parse. Each pytest function maps to one node:test test().
//
// Mapping notes (snake_case Python -> camelCase TS):
//   * OpenAICompatibleConnector(base_url=...) -> new OpenAICompatibleConnector('local', baseUrl)
//     (TS takes baseUrl as the 2nd positional arg; connectorId defaults to 'local').
//   * conn.make_agent_client(model=...) -> conn.makeAgentClient({ model })
//   * client.endpoint / client.last_usage -> client.endpoint / client.lastUsage
//   * OpenAIConnector(api_key=...) -> new OpenAIConnector({ apiKey })
//   * repr(conn) (CONSTITUTION S1/S8 secret hiding) -> conn.toString()
//   * EgressError import comes from ./egress (Python: connectors.egress).
//
// The Anthropic _chat test monkeypatched `requests.post`; the TS port injects a
// fake `fetchImpl: FetchLike`. The connector's makeAgentClient does not expose a
// fetchImpl seam, so we build the AnthropicAgentClient directly with the same
// endpoint/model/apiKey the connector would produce and inject the fake fetch —
// preserving the pytest's intent (parse + header/body shape of the Messages API).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentClient } from '../engine/agent';
import type { FetchLike } from '../engine/http';
import type { ChatMessage } from '../engine/types';

import {
  AnthropicAgentClient,
  AnthropicConnector,
  ANTHROPIC_DEFAULT_BASE,
} from '../orchestrator/connectors/anthropic';
import { EgressError } from '../orchestrator/connectors/egress';
import { OpenAIConnector } from '../orchestrator/connectors/openai';
import { OpenAICompatibleConnector } from '../orchestrator/connectors/openaiCompatible';

// A minimal Response-like shaped for the FetchLike/fetchJson contract
// (ok/status/json/text) — mirrors the Python _FakeResp (.json()/raise_for_status).
function fakeResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------

test('local_connector_builds_agent_client', () => {
  const conn = new OpenAICompatibleConnector('local', 'http://localhost:1234/v1');
  const client = conn.makeAgentClient({ model: 'local-model' });
  assert.ok(client instanceof AgentClient);
  assert.equal(client.endpoint, 'http://localhost:1234/v1');
});

test('connector_repr_hides_secret', () => {
  const conn = new OpenAIConnector({ apiKey: 'sk-super-secret' });
  const repr = conn.toString();
  assert.ok(!repr.includes('sk-super-secret'));
  assert.ok(repr.includes('api_key=set'));
});

test('local_connector_rejects_remote_base', () => {
  // allowRemote is forced False for the local connector -> a remote base fails
  // fast at construction with EgressError.
  assert.throws(
    () => new OpenAICompatibleConnector('local', 'https://api.openai.com/v1'),
    EgressError,
  );
});

test('anthropic_connector_builds_anthropic_client', () => {
  const conn = new AnthropicConnector({ apiKey: 'k' });
  const client = conn.makeAgentClient({ model: 'claude-x' });
  assert.ok(client instanceof AnthropicAgentClient);
});

test('anthropic_chat_parses_messages_api', async () => {
  const captured: {
    url?: string;
    headers?: Record<string, string>;
    body?: { system?: string; messages: Array<{ role: string; content: string }> };
  } = {};

  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.headers = init.headers as Record<string, string>;
    captured.body = JSON.parse(String(init.body)) as {
      system?: string;
      messages: Array<{ role: string; content: string }>;
    };
    return fakeResponse(200, {
      content: [{ type: 'text', text: 'hello from claude' }],
      usage: { input_tokens: 7, output_tokens: 11 },
    });
  }) as unknown as FetchLike;

  // The connector would build an AnthropicAgentClient with this endpoint/model/key;
  // construct it directly so we can inject the fake fetch (no makeAgentClient seam).
  const client = new AnthropicAgentClient({
    endpoint: ANTHROPIC_DEFAULT_BASE,
    model: 'claude-x',
    apiKey: 'k',
    fetchImpl,
  });

  const conversation: ChatMessage[] = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ];
  const out = await client.speak(conversation);
  assert.equal(out, 'hello from claude');
  assert.deepEqual(client.lastUsage, { prompt: 7, completion: 11 });

  // Anthropic specifics: /messages path, x-api-key header, system pulled out-of-band.
  assert.ok(captured.url!.endsWith('/messages'));
  assert.equal(captured.headers!['x-api-key'], 'k');
  assert.equal(captured.body!.system, 'be terse');
  assert.ok(captured.body!.messages.every((m) => m.role !== 'system'));
});
