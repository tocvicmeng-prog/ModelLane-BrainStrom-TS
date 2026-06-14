// factory.ts (N3) — build a connector from a plain definition + a secret.
//
// Used by the rpc_server's run.group path to turn the TS-side connector catalog
// (kind + base_url, NO secret) plus the in-memory provisioned secret into a live,
// egress-guarded connector. Kept in its own module so importing a sibling
// `./<connector>` stays cheap.

import { AnthropicConnector } from './anthropic';
import type { ConnectorInterface } from './base';
import { CliConnector } from './cli';
import { OpenAIConnector } from './openai';
import { OpenAICompatibleConnector } from './openaiCompatible';

/** CLI fields carried alongside the plain definition (Python `**extra`). All
 *  optional — `makeConnector` applies the same defaults as the Python factory. */
export interface ConnectorExtra {
  command?: string | string[];
  promptVia?: 'stdin' | 'arg';
  cwd?: string | null;
  timeout?: number;
  maxOutputChars?: number;
  envPassthrough?: string[] | null;
  allowFileTools?: boolean;
}

/** Options for `makeConnector` (the Python keyword-only args). */
export interface MakeConnectorOptions extends ConnectorExtra {
  apiKey?: string | null;
  allowRemote?: boolean;
}

const DEFAULT_TIMEOUT = 120;
const DEFAULT_MAX_OUTPUT = 100_000;

/** Build a connector from a plain definition. `extra` carries CLI fields
 *  (command, promptVia, cwd, timeout, maxOutputChars, allowFileTools). */
export function makeConnector(
  kind: string,
  connectorId: string,
  baseUrl = '',
  opts: MakeConnectorOptions = {},
): ConnectorInterface {
  const { apiKey = null, allowRemote = false } = opts;
  if (kind === 'cli') {
    return new CliConnector(connectorId, {
      command: opts.command ?? baseUrl,
      promptVia: opts.promptVia ?? 'stdin',
      cwd: opts.cwd ?? null,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      maxOutputChars: opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT,
      envPassthrough: opts.envPassthrough ?? null,
      allowFileTools: opts.allowFileTools ?? false,
    });
  }
  if (kind === 'anthropic') {
    return new AnthropicConnector({ connectorId, baseUrl, apiKey, allowRemote });
  }
  if (kind === 'openai') {
    return new OpenAIConnector({ connectorId, baseUrl, apiKey, allowRemote });
  }
  return new OpenAICompatibleConnector(connectorId, baseUrl, { apiKey });
}

/** Alias matching the task's `buildConnector(kind, def)` framing — same dispatch. */
export const buildConnector = makeConnector;
