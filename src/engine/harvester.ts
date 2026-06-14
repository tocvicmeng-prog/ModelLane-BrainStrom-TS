// harvester.ts (N13, v2.1) — Continuous best-effort insight capture.
//
// Mines a round's FULL prose (PROPOSE slips + CLASH move rationales + RECOMMEND
// synthesis) for innovation points — closes the v2.0 leak where only PROPOSE
// reached the ledger. Technique stack: Claimify-style select→disambiguate→
// decompose (folded into one structured extraction call to stay ~1 call/round at
// `standard`), SAFE decontextualisation, dedup at θ_dup before ingest, and a
// Self-Refine "until-dry" omission loop at `high_stakes`.
//
// HONESTY (THEORY §7.13): capture is *best-effort, audited*, NOT recall-complete —
// correlated extractors share misses. The harvester ABSTAINS rather than
// over-fragment a simple claim (Decomposition Dilemmas). coverage/estimatedRecall
// are telemetry only.
//
// The extractor is duck-typed (`.speak(messages) -> Promise<string>`,
// `.modelFamily`) so tests mock it with zero tokens. See ARCHITECTURE.md §4.10.

import { randomUUID } from 'node:crypto';

import { EmbeddingsClient } from './embeddings';
import {
  DEFAULT_THETA_DUP,
  HarvestSource,
  InsightRecord,
  Phase,
  makeInsightRecord,
  type ChatMessage,
} from './types';

// Minimal duck-typed extractor surface (AgentClient satisfies this).
export interface Extractor {
  speak(conversation: ChatMessage[], temperature?: number): Promise<string>;
  modelFamily: string;
}

const PRONOUN_RE = /^(it|this|that|they|these|those|such)\b/i;
const TRIVIAL: ReadonlySet<string> = new Set([
  'yes', 'no', 'ok', 'okay', 'agreed', 'i agree', 'true', 'false', 'sure', 'right',
]);

const PHASE_SOURCE: Record<string, string> = {
  [Phase.PROPOSE]: HarvestSource.LONG_FORM,
  [Phase.CLASH]: HarvestSource.MOVE_RATIONALE,
  [Phase.RECOMMEND]: HarvestSource.SYNTHESIS,
};

const EXTRACT_PROMPT =
  'You mine debate transcripts for innovation points. From the transcript below, ' +
  'extract every DISTINCT, verifiable insight. Write each as ONE atomic, self-contained ' +
  'statement (resolve pronouns and references — it must stand alone). Omit filler, ' +
  'agreement, and procedural chatter. Output ONLY a JSON array of objects ' +
  '{"text": "...", "author_agent": "A"|"B"}.\n\nTRANSCRIPT:\n';

const OMISSION_PROMPT =
  'Here are insights already captured from the transcript:\n{captured}\n\n' +
  'Identify any DISTINCT insight present in the transcript but NOT already covered. ' +
  'Output ONLY a JSON array of {"text": "..."} (empty array [] if none).\n\nTRANSCRIPT:\n';

/** A raw extracted item before it becomes an InsightRecord. */
export interface RawInsight {
  text?: unknown;
  author_agent?: unknown;
}

/** Context dict passed into harvestRound (all fields optional). */
export interface HarvestContext {
  phase?: string;
  families?: Record<string, string>;
  author_agent?: string;
  author_model_family?: string;
  source_turn?: string;
  subject?: string;
  [key: string]: unknown;
}

export class Harvester {
  primary: Extractor;
  second: Extractor | null;
  embeddings: EmbeddingsClient | null;
  thetaDup: number;
  minChars: number;
  maxHarvestPasses: number;
  lastOmissionPasses = 0;

  constructor(
    extractor: Extractor,
    embeddings: EmbeddingsClient | null = null,
    secondExtractor: Extractor | null = null,
    thetaDup: number = DEFAULT_THETA_DUP,
    minChars = 15,
    maxHarvestPasses = 3,
  ) {
    this.primary = extractor;
    this.second = secondExtractor;
    this.embeddings = embeddings;
    this.thetaDup = thetaDup;
    this.minChars = minChars;
    this.maxHarvestPasses = maxHarvestPasses;
    this.lastOmissionPasses = 0;
  }

  // -- public -----------------------------------------------------------
  async harvestRound(
    roundTranscript: string,
    context: HarvestContext | null = null,
    tier: string = 'standard',
    atBoundary = false,
  ): Promise<InsightRecord[]> {
    const ctx: HarvestContext = context ?? {};
    const resolvedTier = tierValue(tier); // accept RigorTier or str
    const kept: InsightRecord[] = [];
    this.lastOmissionPasses = 0;

    const first = await this.toRecords(
      await this.extract(roundTranscript, ctx, this.primary),
      ctx,
    );
    await this.addNew(first, kept);

    if (resolvedTier === 'economy') {
      return kept;
    }

    if (atBoundary) {
      // 2nd disjoint-family pass at the CLASH→RECOMMEND boundary (standard+).
      const extractor = this.second ?? this.primary;
      const extra = await this.toRecords(
        await this.extract(roundTranscript, ctx, extractor),
        ctx,
      );
      await this.addNew(extra, kept);
    }

    if (resolvedTier === 'high_stakes') {
      let passes = 1;
      while (passes < this.maxHarvestPasses) {
        const extractor = this.second ?? this.primary;
        const raw = await this.omissionCritic(
          roundTranscript,
          kept.map((r) => r.text),
          extractor,
        );
        const extra = await this.toRecords(raw, ctx);
        passes += 1;
        this.lastOmissionPasses += 1;
        if ((await this.addNew(extra, kept)) === 0) {
          break; // until-dry: a pass that adds nothing stops the loop
        }
      }
    }
    return kept;
  }

  async omissionCritic(
    transcript: string,
    captured: string[],
    extractor: Extractor,
  ): Promise<RawInsight[]> {
    const bullet = captured.map((c) => `- ${c}`).join('\n') || '(none)';
    const prompt = OMISSION_PROMPT.replace('{captured}', bullet) + transcript;
    return parseArray(await extractor.speak([{ role: 'user', content: prompt }]));
  }

  // -- internals --------------------------------------------------------
  private async extract(
    transcript: string,
    _context: HarvestContext,
    extractor: Extractor,
  ): Promise<RawInsight[]> {
    const prompt = EXTRACT_PROMPT + transcript;
    return parseArray(await extractor.speak([{ role: 'user', content: prompt }]));
  }

  private async toRecords(raw: RawInsight[], context: HarvestContext): Promise<InsightRecord[]> {
    const phase = context.phase ?? Phase.CLASH;
    const source = PHASE_SOURCE[phase] ?? HarvestSource.LONG_FORM;
    const families = context.families ?? {};
    const records: InsightRecord[] = [];
    for (const item of raw) {
      const text = this.decontextualize(String(item.text ?? '').trim(), context);
      if (this.abstain(text)) {
        continue; // ABSTAIN — do not over-fragment / emit filler
      }
      const author =
        (item.author_agent !== undefined && item.author_agent !== null && item.author_agent !== ''
          ? String(item.author_agent)
          : undefined) ?? context.author_agent ?? 'A';
      const family = families[author] ?? context.author_model_family ?? 'unknown';
      records.push(
        makeInsightRecord({
          id: 'ins-' + randomUUID().replace(/-/g, '').slice(0, 10),
          text,
          sourceTurn: context.source_turn ?? '',
          sourcePhase: phase,
          authorAgent: author,
          authorModelFamily: family,
          spanType: source,
          harvestedFrom: source,
        }),
      );
    }
    await this.attachEmbeddings(records);
    return records;
  }

  // SAFE-style: resolve a leading pronoun against a known subject, if any.
  private decontextualize(text: string, context: HarvestContext): string {
    const subject = context.subject;
    if (subject && PRONOUN_RE.test(text)) {
      return text.replace(PRONOUN_RE, subject);
    }
    return text;
  }

  private abstain(text: string): boolean {
    // Count Unicode code points (Python len()), not UTF-16 units, at the boundary.
    if ([...text].length < this.minChars) {
      return true;
    }
    return TRIVIAL.has(text.toLowerCase().replace(/^[.!? ]+|[.!? ]+$/g, ''));
  }

  private async attachEmbeddings(records: InsightRecord[]): Promise<void> {
    if (this.embeddings === null || records.length === 0) {
      return;
    }
    const vectors = await this.embeddings.embed(records.map((r) => r.text));
    for (let i = 0; i < records.length; i++) {
      records[i]!.embedding = vectors[i]!;
    }
  }

  private similarity(a: InsightRecord, b: InsightRecord): number {
    if (a.embedding !== null && b.embedding !== null) {
      return EmbeddingsClient.cosine(a.embedding, b.embedding);
    }
    return EmbeddingsClient.jaccard(a.text, b.text);
  }

  // Add only candidates that are not near-duplicates of what is already kept.
  private async addNew(candidates: InsightRecord[], kept: InsightRecord[]): Promise<number> {
    let added = 0;
    for (const cand of candidates) {
      if (kept.some((k) => this.similarity(cand, k) >= this.thetaDup)) {
        continue;
      }
      kept.push(cand);
      added += 1;
    }
    return added;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Accept a RigorTier enum value or a plain string (Python's getattr(tier, "value", tier)).
function tierValue(tier: unknown): string {
  if (typeof tier === 'object' && tier !== null && 'value' in tier) {
    return String((tier as { value: unknown }).value);
  }
  return String(tier);
}

// ---------------------------------------------------------------------------
// Tolerant JSON-array parsing
// ---------------------------------------------------------------------------

export function parseArray(raw: string): RawInsight[] {
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    const m = /\[[\s\S]*\]/.exec(raw || '');
    if (m) {
      try {
        data = JSON.parse(m[0]);
      } catch {
        data = null;
      }
    }
  }
  if (Array.isArray(data)) {
    return data.map((d) => (isPlainObject(d) ? (d as RawInsight) : { text: String(d) }));
  }
  if (isPlainObject(data) && Array.isArray((data as Record<string, unknown>).insights)) {
    const insights = (data as Record<string, unknown>).insights as unknown[];
    return insights.map((d) => (isPlainObject(d) ? (d as RawInsight) : { text: String(d) }));
  }
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
