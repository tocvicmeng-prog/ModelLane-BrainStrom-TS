// openaiCompatible.ts (N3) — local / self-hosted OpenAI-compatible connector.
//
// For LM Studio, llama.cpp, Ollama (OpenAI-compatible mode), vLLM, etc. Defaults
// to a loopback endpoint, so it is allowed by the egress guard without any remote
// opt-in. This is the connector used by the M1 walking skeleton's local seat pair.

import { BaseConnector, type BaseConnectorOptions } from './base';

export const LOCAL_DEFAULT_BASE = 'http://localhost:1234/v1';

/** Extra connector options forwarded by the local connector. `allowRemote` is
 *  forced off here, so it is excluded from the caller-facing option set. */
export type OpenAICompatibleConnectorOptions = Omit<BaseConnectorOptions, 'allowRemote'>;

export class OpenAICompatibleConnector extends BaseConnector {
  override kind = 'openai-compatible';

  constructor(
    connectorId = 'local',
    baseUrl: string = LOCAL_DEFAULT_BASE,
    opts: OpenAICompatibleConnectorOptions = {},
  ) {
    // Local endpoint: remote egress is always disallowed (loopback only).
    super(connectorId, baseUrl, { ...opts, allowRemote: false });
  }
}
