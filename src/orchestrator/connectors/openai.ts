// openai.ts (N3) — OpenAI API connector.
//
// Default debate seat for the "OpenAI (Codex-style persona)" default (CONSTITUTION
// F1 hybrid policy). Uses the stock OpenAI-compatible AgentClient against the
// OpenAI /chat/completions endpoint.

import { BaseConnector, type BaseConnectorOptions } from './base';

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

/** Constructor options for OpenAIConnector (camelCased from the Python kwargs).
 *  `allowRemote` defaults to true here (remote by nature); the allowlist + https
 *  checks in egress still apply. */
export interface OpenAIConnectorOptions extends BaseConnectorOptions {
  connectorId?: string;
  baseUrl?: string;
}

export class OpenAIConnector extends BaseConnector {
  kind = 'openai';

  constructor(opts: OpenAIConnectorOptions = {}) {
    const { connectorId = 'openai', baseUrl = OPENAI_DEFAULT_BASE, ...rest } = opts;
    // Remote by nature; the allowlist + https checks in egress still apply.
    // (spread first, then default allowRemote=true when caller left it unset)
    super(connectorId, baseUrl, { ...rest, allowRemote: rest.allowRemote ?? true });
  }
}
