// embeddings.ts (N10) — OpenAI-compatible embeddings client.
//
// embed() calls POST /v1/embeddings, content-hash caches results (in-memory +
// best-effort on disk so the cache survives restarts), and batches requests. When
// the endpoint is unreachable it falls back to a deterministic hashing-bag-of-words
// vector (a lexical proxy in the Jaccard family) and sets degraded = true, so
// downstream cosine still returns a usable lexical-overlap signal. A configured
// expectedDim mismatch throws (dimension guard). See ARCHITECTURE.md §8.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { fetchJson, FetchLike, httpFetch } from './http';
import { sha256hex } from './util';

const FALLBACK_DIM = 256;
const BATCH = 64;
const TOKEN_RE = /[a-z0-9]+/g;

/** Tokenize lowercased text into [a-z0-9]+ runs (replaces _TOKEN_RE.findall). */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

export interface EmbeddingsClientOptions {
  endpoint?: string;
  model?: string;
  apiKey?: string | null;
  expectedDim?: number | null;
  cacheDir?: string;
  /** Timeout in seconds (matches Python's int seconds). */
  timeout?: number;
  mockVectors?: Record<string, number[]> | null;
  fetchImpl?: FetchLike;
}

export class EmbeddingsClient {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string | null;
  readonly expectedDim: number | null;
  readonly cacheDir: string;
  readonly timeout: number;
  readonly mockVectors: Record<string, number[]> | null;
  degraded = false;

  private readonly fetchImpl: FetchLike;
  private readonly memCache: Map<string, number[]> = new Map();

  constructor(opts: EmbeddingsClientOptions = {}) {
    this.endpoint = (opts.endpoint ?? 'http://localhost:1234/v1').replace(/\/+$/, '');
    this.model = opts.model ?? 'nomic-embed-text';
    this.apiKey = opts.apiKey ?? null;
    this.expectedDim = opts.expectedDim ?? null;
    this.cacheDir = opts.cacheDir ?? './data/cache/embeddings';
    this.timeout = opts.timeout ?? 60;
    this.mockVectors = opts.mockVectors ?? null;
    this.fetchImpl = opts.fetchImpl ?? httpFetch;
  }

  // -- hashing / cache --------------------------------------------------
  private key(text: string): string {
    return sha256hex(`${this.model}\x00${text}`);
  }

  private diskGet(key: string): number[] | null {
    const p = path.join(this.cacheDir, `${key}.json`);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as number[];
      } catch {
        return null;
      }
    }
    return null;
  }

  private diskPut(key: string, vec: number[]): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(path.join(this.cacheDir, `${key}.json`), JSON.stringify(vec), 'utf-8');
    } catch {
      // cache is best-effort; never fail a run on a cache write
    }
  }

  // -- public API -------------------------------------------------------
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const results: Map<number, number[]> = new Map();
    const misses: Array<[number, string]> = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (this.mockVectors !== null && Object.prototype.hasOwnProperty.call(this.mockVectors, text)) {
        results.set(i, this.mockVectors[text]!);
        continue;
      }
      const key = this.key(text);
      const cached = this.memCache.get(key) ?? this.diskGet(key);
      if (cached !== null && cached !== undefined) {
        this.memCache.set(key, cached);
        results.set(i, cached);
      } else {
        misses.push([i, text]);
      }
    }

    for (let start = 0; start < misses.length; start += BATCH) {
      const batch = misses.slice(start, start + BATCH);
      const vectors = await this.embedBatch(batch.map(([, t]) => t));
      for (let j = 0; j < batch.length; j++) {
        const [i, text] = batch[j]!;
        const vec = vectors[j]!;
        this.checkDim(vec);
        const key = this.key(text);
        this.memCache.set(key, vec);
        this.diskPut(key, vec);
        results.set(i, vec);
      }
    }

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(results.get(i)!);
    }
    return out;
  }

  /** Embed a single text; returns the lone vector. */
  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec!;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    if (this.mockVectors !== null) {
      // Any text not present in mockVectors gets a deterministic lexical vector.
      const mv = this.mockVectors;
      return batch.map((t) =>
        Object.prototype.hasOwnProperty.call(mv, t) ? mv[t]! : this.lexicalVector(t),
      );
    }
    const url = `${this.endpoint}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    try {
      const data = await fetchJson(
        url,
        { method: 'POST', headers, body: JSON.stringify({ model: this.model, input: batch }) },
        this.timeout * 1000,
        this.fetchImpl,
      );
      const items = [...(data.data as Array<{ index?: number; embedding: unknown[] }>)].sort(
        (x, y) => (x.index ?? 0) - (y.index ?? 0),
      );
      return items.map((item) => item.embedding.map((v) => Number(v)));
    } catch {
      this.degraded = true;
      return batch.map((t) => this.lexicalVector(t));
    }
  }

  private checkDim(vec: number[]): void {
    if (this.expectedDim !== null && vec.length !== this.expectedDim) {
      throw new Error(`embedding dim ${vec.length} != expected ${this.expectedDim}`);
    }
  }

  /**
   * Deterministic hashing bag-of-words (binary token presence).
   * cosine over these approximates lexical overlap — a usable degraded signal.
   */
  private lexicalVector(text: string): number[] {
    const dim = this.expectedDim ?? FALLBACK_DIM;
    const vec = new Array<number>(dim).fill(0.0);
    for (const tok of new Set(tokenize(text))) {
      const digest = createHash('sha1').update(tok, 'utf-8').digest('hex');
      const h = Number(BigInt(`0x${digest}`) % BigInt(dim));
      vec[h] = 1.0;
    }
    return vec;
  }

  static cosine(a: number[], b: number[]): number {
    return cosine(a, b);
  }

  static jaccard(textA: string, textB: string): number {
    return jaccard(textA, textB);
  }
}

/** Cosine similarity; 0.0 for empty / mismatched / zero-norm vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0.0;
  }
  let dot = 0.0;
  let na = 0.0;
  let nb = 0.0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  if (na === 0.0 || nb === 0.0) {
    return 0.0;
  }
  return dot / (na * nb);
}

/** Jaccard token overlap over lowercased [a-z0-9]+ tokens. */
export function jaccard(textA: string, textB: string): number {
  const ta = new Set(tokenize(textA));
  const tb = new Set(tokenize(textB));
  if (ta.size === 0 && tb.size === 0) {
    return 0.0;
  }
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      inter++;
    }
  }
  const union = ta.size + tb.size - inter;
  return inter / union;
}

/** Deterministic hashing bag-of-words vector (exported lexical fallback helper). */
export function lexicalVector(text: string, expectedDim: number | null = null): number[] {
  const dim = expectedDim ?? FALLBACK_DIM;
  const vec = new Array<number>(dim).fill(0.0);
  for (const tok of new Set(tokenize(text))) {
    const digest = createHash('sha1').update(tok, 'utf-8').digest('hex');
    const h = Number(BigInt(`0x${digest}`) % BigInt(dim));
    vec[h] = 1.0;
  }
  return vec;
}
