// agent.ts (N5) — OpenAI-compatible LLM client + structured-output helpers.
//
// Thin wrapper around a `/chat/completions` endpoint (LM Studio / Ollama / remote).
// All network access flows through `chat()` (protected, overridable), which tests
// inject a fake fetch into or bypass via a constructor-supplied `mockResponse`.
// Adds the v2 debate helpers `requestSlips()` (PROPOSE idea slips) and
// `requestMove()` (CLASH typed move) with JSON-or-text parse fallback.
// Zero token cost in tests (T3 mock tier).

import { randomUUID } from 'node:crypto';

import { HttpError, fetchJson, httpFetch, type FetchLike } from './http';
import {
  MoveType,
  Phase,
  makeIdeaRecord,
  makeMove,
  type ChatMessage,
  type IdeaRecord,
  type Move,
} from './types';

const MAX_SLIP_WORDS = 50;

/** Usage counters surfaced after each `chat()` call (frozen API shape). */
export interface AgentUsage {
  prompt: number;
  completion: number;
}

/** Injectable async sleep (tests pass a no-op); defaults to a real timer. */
export type SleepLike = (ms: number) => Promise<void>;

const defaultSleep: SleepLike = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Constructor options for AgentClient (camelCased from the Python kwargs). */
export interface AgentClientOptions {
  endpoint: string;
  model: string;
  apiKey?: string | null;
  systemPrompt?: string;
  modelFamily?: string;
  temperature?: number;
  timeout?: number; // seconds (matches Python `requests` timeout units)
  maxRetries?: number;
  retryBackoff?: number; // seconds base; backoff = retryBackoff * 2**attempt
  mockResponse?: string | null;
  agentLabel?: string;
  fetchImpl?: FetchLike; // injectable for tests
  sleepImpl?: SleepLike; // injectable for tests (avoid real backoff waits)
}

export class AgentClient {
  endpoint: string;
  model: string;
  apiKey: string | null;
  systemPrompt: string;
  modelFamily: string;
  temperature: number;
  timeout: number;
  maxRetries: number;
  retryBackoff: number;
  mockResponse: string | null;
  agentLabel: string;
  injectedContext: string[] = [];
  lastUsage: AgentUsage = { prompt: 0, completion: 0 };

  protected fetchImpl: FetchLike;
  protected sleepImpl: SleepLike;

  constructor(opts: AgentClientOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? null;
    this.systemPrompt = opts.systemPrompt ?? '';
    this.modelFamily = opts.modelFamily ?? 'unknown';
    this.temperature = opts.temperature ?? 0.7;
    this.timeout = opts.timeout ?? 120;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBackoff = opts.retryBackoff ?? 0.5;
    this.mockResponse = opts.mockResponse ?? null;
    this.agentLabel = opts.agentLabel ?? 'A';
    this.fetchImpl = opts.fetchImpl ?? httpFetch;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
  }

  // -- context injection (P10) -----------------------------------------
  /** Attach a knowledge packet; surfaced as a system message in speak(). */
  injectContext(knowledge: string): void {
    if (knowledge.trim()) {
      this.injectedContext.push(knowledge.trim());
    }
  }

  protected buildMessages(conversation: ChatMessage[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    for (const ctx of this.injectedContext) {
      messages.push({ role: 'system', content: `[BACKGROUND KNOWLEDGE]\n${ctx}` });
    }
    messages.push(...conversation);
    return messages;
  }

  // -- core call --------------------------------------------------------
  async speak(conversation: ChatMessage[], temperature?: number): Promise<string> {
    if (this.mockResponse !== null) {
      this.lastUsage = { prompt: 0, completion: 0 };
      return this.mockResponse;
    }
    const messages = this.buildMessages(conversation);
    return this.chat(messages, temperature !== undefined ? temperature : this.temperature);
  }

  // OpenAI-shaped POST {endpoint}/chat/completions. Overridable so an Anthropic
  // subclass and a CLI subclass can replace ONLY this method.
  protected async chat(messages: ChatMessage[], temperature: number): Promise<string> {
    const url = `${this.endpoint}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const payload = { model: this.model, messages, temperature };
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
        data = await fetchJson(url, init, timeoutMs, this.fetchImpl);
      } catch (exc) {
        lastExc = exc;
        // Match Python: a 4xx fails fast (raise_for_status is outside the retry
        // try/except); only network/timeout and 5xx are retried with backoff.
        if (exc instanceof HttpError && exc.status < 500) {
          throw exc;
        }
        if (attempt < this.maxRetries) {
          await this.sleepImpl(this.retryBackoff * 2 ** attempt * 1000);
          continue;
        }
        throw new Error(`agent endpoint unreachable: ${stringifyError(exc)}`);
      }
      const usage = (data && data.usage) || {};
      this.lastUsage = {
        prompt: toInt(usage.prompt_tokens),
        completion: toInt(usage.completion_tokens),
      };
      return data.choices[0].message.content;
    }
    throw new Error(`agent call failed: ${stringifyError(lastExc)}`);
  }

  /** Conservative estimate (~2 chars/token, CJK-aware) when no tokenizer. */
  countTokens(text: string): number {
    return Math.max(1, Math.floor(text.length / 2));
  }

  // -- v2 structured-output helpers ------------------------------------
  // Ask for 3 new idea slips (+ <=1 build-on), each <=50 words.
  // Parses a JSON array of {"text", "build_on"?}; falls back to line splitting.
  async requestSlips(
    prompt: string,
    roundNumber = 0,
    phase: string = Phase.PROPOSE,
  ): Promise<IdeaRecord[]> {
    const raw = await this.speak([{ role: 'user', content: prompt }], this.temperature);
    const slips = parseSlips(raw);
    const out: IdeaRecord[] = [];
    for (const s of slips) {
      const text = truncateWords(String(s.text ?? '').trim(), MAX_SLIP_WORDS);
      if (!text) {
        continue;
      }
      out.push(
        makeIdeaRecord({
          id: 'idea-' + randomUUID().replace(/-/g, '').slice(0, 10),
          text,
          agent: this.agentLabel,
          roundNumber,
          phase,
          modelFamily: this.modelFamily,
          parentIds: s.build_on ? [String(s.build_on)] : [],
          harvestedFrom: 'slip',
        }),
      );
    }
    return out;
  }

  // Ask for one typed argument move; falls back to a CLAIM wrapping the text.
  async requestMove(
    prompt: string,
    roundNumber = 0,
    phase: string = Phase.CLASH,
  ): Promise<Move> {
    const raw = await this.speak([{ role: 'user', content: prompt }], this.temperature);
    const parsed = parseMove(raw);
    let moveType = String(parsed.move_type ?? MoveType.CLAIM).toUpperCase();
    const legal = new Set<string>(Object.values(MoveType));
    if (!legal.has(moveType)) {
      moveType = MoveType.CLAIM;
    }
    return makeMove({
      id: 'move-' + randomUUID().replace(/-/g, '').slice(0, 10),
      agent: this.agentLabel,
      moveType,
      content: String(parsed.content ?? raw).trim(),
      targetId: parsed.target_id !== undefined && parsed.target_id !== null
        ? String(parsed.target_id)
        : null,
      roundNumber,
      phase,
    });
  }
}

// ---------------------------------------------------------------------------
// Parse helpers (tolerant of imperfect LLM JSON)
// ---------------------------------------------------------------------------

export function extractJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to embedded-JSON search
  }
  // Try to locate a JSON array or object embedded in prose (DOTALL, greedy).
  for (const pattern of [/\[[\s\S]*\]/, /\{[\s\S]*\}/]) {
    const m = pattern.exec(raw);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        continue;
      }
    }
  }
  return null;
}

interface SlipDict {
  text?: unknown;
  build_on?: unknown;
}

export function parseSlips(raw: string): SlipDict[] {
  const data = extractJson(raw);
  if (Array.isArray(data)) {
    return data.map((d) => (isPlainObject(d) ? (d as SlipDict) : { text: String(d) }));
  }
  if (isPlainObject(data) && Array.isArray((data as Record<string, unknown>).slips)) {
    const slips = (data as Record<string, unknown>).slips as unknown[];
    return slips.map((d) => (isPlainObject(d) ? (d as SlipDict) : { text: String(d) }));
  }
  // Fallback: one slip per non-empty line, stripping bullet/number prefixes.
  const lines = raw.split(/\r?\n/).map((ln) => ln.replace(/^[\s\-*\d.)]+/, '').trim());
  return lines.filter((ln) => ln).map((ln) => ({ text: ln }));
}

interface MoveDict {
  move_type?: unknown;
  content?: unknown;
  target_id?: unknown;
}

export function parseMove(raw: string): MoveDict {
  const data = extractJson(raw);
  if (isPlainObject(data)) {
    return data as MoveDict;
  }
  return { content: raw };
}

export function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) {
    return text;
  }
  return words.slice(0, maxWords).join(' ');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
