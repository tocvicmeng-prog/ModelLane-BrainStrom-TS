// base.ts (N2) — connector contract + base implementation.
//
// A connector binds a (provider, base_url, secret) to a factory that produces
// engine-compatible LLM clients (AgentClient or a subclass). The secret is held
// in memory only and never appears in repr/logs (CONSTITUTION S1/S8). Egress is
// validated at construction and at every client build (S4/S5).

import {
  AgentClient,
  type AgentClientOptions,
} from '../../engine/agent';
import {
  EmbeddingsClient,
  type EmbeddingsClientOptions,
} from '../../engine/embeddings';

import { DEFAULT_REMOTE_ALLOWLIST, validateEgress } from './egress';

/** Constructible AgentClient (or subclass) from AgentClientOptions — the TS form
 *  of Python's `type[AgentClient]` returned by `_client_cls`. */
export type AgentClientCtor = new (opts: AgentClientOptions) => AgentClient;

/** Pure-data capabilities descriptor (Python @dataclass, frozen). */
export interface ConnectorCapabilities {
  kind: string;
  supportsSystemPrompt: boolean;
  // Streaming is GROUP-grain only (engine emits phase events via onEvent; never
  // per-seat/per-token) — see ARCHITECTURE streaming stance.
  streaming: boolean;
}

/** Build a ConnectorCapabilities with the dataclass defaults. */
export function makeConnectorCapabilities(
  partial: Partial<ConnectorCapabilities> & { kind: string },
): ConnectorCapabilities {
  return {
    kind: partial.kind,
    supportsSystemPrompt: partial.supportsSystemPrompt ?? true,
    streaming: partial.streaming ?? false,
  };
}

/** Args for the seat→client contract (camelCased from the Python kwargs). */
export interface MakeAgentClientArgs {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  modelFamily?: string;
  agentLabel?: string;
}

/** The seat→client contract every connector implements (Python runtime Protocol). */
export interface ConnectorInterface {
  kind: string;
  makeAgentClient(args: MakeAgentClientArgs): AgentClient;
  capabilities(): ConnectorCapabilities;
}

/** Args for building an egress-guarded embeddings client. */
export interface MakeEmbeddingsClientArgs {
  model?: string;
  cacheDir?: string | null;
  expectedDim?: number | null;
}

/** Constructor options for BaseConnector (camelCased from the Python kwargs). */
export interface BaseConnectorOptions {
  apiKey?: string | null;
  allowRemote?: boolean;
  allowlist?: ReadonlySet<string>;
  timeout?: number;
  maxRetries?: number;
}

/** OpenAI-compatible connector. Subclasses set `kind` / override `clientCls`. */
export class BaseConnector implements ConnectorInterface {
  kind = 'openai-compatible';

  readonly connectorId: string;
  readonly baseUrl: string;
  // secret — memory only, excluded from any string form (see toString).
  protected readonly apiKey: string | null;
  readonly allowRemote: boolean;
  readonly allowlist: ReadonlySet<string>;
  readonly timeout: number;
  readonly maxRetries: number;

  constructor(connectorId: string, baseUrl: string, opts: BaseConnectorOptions = {}) {
    this.connectorId = connectorId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.allowRemote = opts.allowRemote ?? false;
    this.allowlist = opts.allowlist ?? DEFAULT_REMOTE_ALLOWLIST;
    this.timeout = opts.timeout ?? 120;
    this.maxRetries = opts.maxRetries ?? 2;
    // Validate the endpoint up front so a bad/blocked URL fails fast (S4/S5).
    validateEgress(this.baseUrl, this.allowRemote, this.allowlist);
  }

  // Subclasses override to return AgentClient or a provider subclass (e.g. Anthropic).
  protected clientCls(): AgentClientCtor {
    return AgentClient;
  }

  capabilities(): ConnectorCapabilities {
    return makeConnectorCapabilities({ kind: this.kind });
  }

  makeAgentClient(args: MakeAgentClientArgs): AgentClient {
    // Re-validate before every build — config could have changed since construction.
    validateEgress(this.baseUrl, this.allowRemote, this.allowlist);
    const Cls = this.clientCls();
    return new Cls({
      endpoint: this.baseUrl,
      model: args.model,
      apiKey: this.apiKey,
      systemPrompt: args.systemPrompt ?? '',
      modelFamily: args.modelFamily ?? 'unknown',
      temperature: args.temperature ?? 0.7,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      agentLabel: args.agentLabel ?? 'A',
    });
  }

  // Build an egress-guarded embeddings client (the secret stays inside the connector).
  // `cacheDir` should be set by the caller to a path under the extension's
  // globalStorageUri (F5) — never the repo or sidecar cwd.
  makeEmbeddingsClient(args: MakeEmbeddingsClientArgs = {}): EmbeddingsClient {
    validateEgress(this.baseUrl, this.allowRemote, this.allowlist);
    const opts: EmbeddingsClientOptions = {
      endpoint: this.baseUrl,
      model: args.model ?? 'nomic-embed-text',
      apiKey: this.apiKey,
      expectedDim: args.expectedDim ?? null,
      cacheDir: args.cacheDir ?? './data/cache/embeddings',
      timeout: this.timeout,
    };
    return new EmbeddingsClient(opts);
  }

  // never leak the secret
  toString(): string {
    return (
      `<${this.constructor.name} id=${JSON.stringify(this.connectorId)} ` +
      `kind=${JSON.stringify(this.kind)} base_url=${JSON.stringify(this.baseUrl)} ` +
      `api_key=${this.apiKey ? 'set' : 'none'}>`
    );
  }
}
