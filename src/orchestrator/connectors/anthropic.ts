// anthropic.ts (N3) — Anthropic Messages API connector.
//
// The engine only ever calls AgentClient.speak / requestSlips / requestMove,
// all of which funnel through chat() (the one protected, overridable network
// method). So an Anthropic seat needs only to override chat() + populate
// lastUsage — everything else is inherited (ARCHITECTURE F2/F14). The Messages
// API differs from OpenAI in URL path, auth header (x-api-key + anthropic-version),
// a separate `system` field, a required max_tokens, and the response shape
// (content[].text, usage.input_tokens/output_tokens).

import { AgentClient } from '../../engine/agent';
import { HttpError, fetchJson } from '../../engine/http';
import { type ChatMessage } from '../../engine/types';

import { BaseConnector, type AgentClientCtor, type BaseConnectorOptions } from './base';

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

/** AgentClient whose chat() speaks the Anthropic Messages API. */
export class AnthropicAgentClient extends AgentClient {
  // Anthropic takes the system prompt out-of-band and only user/assistant turns inline.
  protected override async chat(messages: ChatMessage[], temperature: number): Promise<string> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const convo = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const url = `${this.endpoint}/messages`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    const payload: Record<string, unknown> = {
      model: this.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      temperature,
      messages: convo,
    };
    if (system) {
      payload['system'] = system;
    }

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
    const timeoutMs = this.timeout * 1000;

    let lastExc: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let data: any;
      try {
        // fetchJson throws HttpError (with .status) on non-2xx, or a generic Error
        // on network/timeout. The catch below retries only 5xx + network/timeout.
        data = await fetchJson(url, init, timeoutMs, this.fetchImpl);
      } catch (exc) {
        lastExc = exc;
        // Match Python: a 4xx fails fast; only network/timeout and 5xx are retried.
        if (exc instanceof HttpError && exc.status < 500) {
          throw exc;
        }
        if (attempt < this.maxRetries) {
          await this.sleepImpl(this.retryBackoff * 2 ** attempt * 1000);
          continue;
        }
        throw new Error(`anthropic endpoint unreachable: ${stringifyError(exc)}`);
      }
      const usage = (data && data.usage) || {};
      this.lastUsage = {
        prompt: toInt(usage.input_tokens),
        completion: toInt(usage.output_tokens),
      };
      const parts: any[] = (data && data.content) || [];
      const text = parts
        .filter((p) => p && p.type === 'text')
        .map((p) => String(p.text ?? ''))
        .join('');
      return text || (parts.length ? String(parts[0].text ?? '') : '');
    }
    throw new Error(`anthropic call failed: ${stringifyError(lastExc)}`);
  }
}

/** Constructor options for AnthropicConnector (camelCased from the Python kwargs).
 *  `allowRemote` defaults to true here (remote by nature); the allowlist + https
 *  checks in egress still apply. */
export interface AnthropicConnectorOptions extends BaseConnectorOptions {
  connectorId?: string;
  baseUrl?: string;
}

/** Connector binding the Anthropic provider to its AgentClient subclass. */
export class AnthropicConnector extends BaseConnector {
  override kind = 'anthropic';

  constructor(opts: AnthropicConnectorOptions = {}) {
    const { connectorId = 'anthropic', baseUrl = ANTHROPIC_DEFAULT_BASE, ...rest } = opts;
    // Remote by nature; the allowlist + https checks in egress still apply.
    // (spread first, then default allowRemote=true when caller left it unset)
    super(connectorId, baseUrl, { ...rest, allowRemote: rest.allowRemote ?? true });
  }

  protected override clientCls(): AgentClientCtor {
    return AnthropicAgentClient;
  }
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
