// metrics.ts (N12) — Entropy / novelty instrumentation over the idea ledger.
//
// The primary objective is σ_SI — the std of per-idea self-information (LD4/P14):
// extreme-value theory gives E[max of N] ≈ μ + σ·√(2 ln N), so past moderate N a unit
// of spread buys more best-idea quality than a unit of mean. The cell *reports* σ_SI;
// the (out-of-scope) pool selects for it. v2.1 adds capture/verification telemetry —
// all secondary; σ_SI stays primary.
//
// Pure math over embeddings (Math + local statistics helpers; no numpy at debate
// scale). See ARCHITECTURE.md §4.7 (entropy), §4.8 (opening diversity / fixation).

import { cosine } from './embeddings';
import {
  CoverageReport,
  DEFAULT_THETA_Q,
  EntropyMetrics,
  IdeaRecord,
  InsightRecord,
  VERIFIED_STATUSES,
  makeCoverageReport,
  makeEntropyMetrics,
} from './types';

const EPS = 1e-12;
const CLUSTER_SIM = 0.75; // greedy leader clustering threshold (ARCHITECTURE §4.7)
const FIXATION_JUMP = 0.15; // cross-agent centroid sim jump flagged as fixation (§4.8)
const DELTA_OPEN = 0.15; // opening-diversity floor

// Structural view of the idea ledger that the metrics need (IdeaLedger satisfies
// this). Kept minimal so metrics.ts does not depend on the ledger implementation.
export interface LedgerLike {
  active(): IdeaRecord[];
  round0(side: string): IdeaRecord[];
  roundIdeas(roundNumber: number, side?: string): IdeaRecord[];
  insights: InsightRecord[];
  degraded?: boolean;
}

// -- statistics helpers (faithful to Python's `statistics` module) -----------

/** Arithmetic mean (statistics.mean). Caller guards the empty case. */
function mean(xs: number[]): number {
  let s = 0.0;
  for (const x of xs) {
    s += x;
  }
  return s / xs.length;
}

/** Median (statistics.median): even length averages the two middle values. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return s[mid]!;
  }
  return (s[mid - 1]! + s[mid]!) / 2.0;
}

/** Population standard deviation (statistics.pstdev): divides by N. */
function pstdev(xs: number[]): number {
  const m = mean(xs);
  let acc = 0.0;
  for (const x of xs) {
    const d = x - m;
    acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
}

// -- geometry helpers --------------------------------------------------------

function cos(a: number[], b: number[]): number {
  return cosine(a, b);
}

function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    return [];
  }
  const dim = vectors[0]!.length;
  const n = vectors.length;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    let s = 0.0;
    for (const v of vectors) {
      s += v[i]!;
    }
    out[i] = s / n;
  }
  return out;
}

function leaderClusters(vectors: number[][], sim: number): number[][] {
  const leaders: number[][] = [];
  const clusters: number[][] = [];
  for (let idx = 0; idx < vectors.length; idx++) {
    const v = vectors[idx]!;
    let placed = false;
    for (let cIdx = 0; cIdx < leaders.length; cIdx++) {
      if (cos(v, leaders[cIdx]!) >= sim) {
        clusters[cIdx]!.push(idx);
        placed = true;
        break;
      }
    }
    if (!placed) {
      leaders.push(v);
      clusters.push([idx]);
    }
  }
  return clusters;
}

/** Per-idea self-information via a cosine-distance KDE (ARCHITECTURE §4.7). */
function selfInformation(vectors: number[][]): number[] {
  const n = vectors.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [0.0];
  }
  const dist: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n);
    for (let j = 0; j < n; j++) {
      row[j] = 1.0 - cos(vectors[i]!, vectors[j]!);
    }
    dist.push(row);
  }
  const offdiag: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        offdiag.push(dist[i]![j]!);
      }
    }
  }
  const h = Math.max(median(offdiag) / 2.0, EPS);
  const si: number[] = [];
  for (let i = 0; i < n; i++) {
    const terms: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== i) {
        const d = dist[i]![j]!;
        terms.push(Math.exp(-(d * d) / (2 * h * h)));
      }
    }
    const kde = mean(terms);
    si.push(-Math.log(kde + EPS));
  }
  return si;
}

/**
 * Cluster-occupancy entropy + σ_SI + fluency-controlled originality.
 *
 * Writes each active idea's selfInfo back onto the record (for persistence and
 * the secondary verified-σ). σ_SI stays the PRIMARY metric.
 */
export function computeEntropyMetrics(ledger: LedgerLike): EntropyMetrics {
  const active = ledger.active().filter((i) => i.embedding && i.embedding.length > 0);
  const vectors = active.map((i) => i.embedding as number[]);
  if (vectors.length === 0) {
    return makeEntropyMetrics({ degraded: ledger.degraded ?? false });
  }

  const clusters = leaderClusters(vectors, CLUSTER_SIM);
  const total = vectors.length;
  const probs = clusters.map((c) => c.length / total);
  let entropy = 0.0;
  for (const p of probs) {
    if (p > 0) {
      entropy -= p * Math.log(p);
    }
  }
  const entropyNorm = clusters.length > 1 ? entropy / Math.log(clusters.length) : 0.0;

  const si = selfInformation(vectors);
  for (let k = 0; k < active.length; k++) {
    active[k]!.selfInfo = si[k]!;
  }
  const sigmaSi = si.length >= 2 ? pstdev(si) : 0.0;
  const meanSi = si.length > 0 ? mean(si) : 0.0;

  const goodSi: number[] = [];
  for (let k = 0; k < active.length; k++) {
    if (active[k]!.quality >= DEFAULT_THETA_Q) {
      goodSi.push(si[k]!);
    }
  }
  const fco = goodSi.length > 0 ? mean(goodSi) : 0.0;

  const verifiedSi = active
    .filter((idea) => idea.verificationStatus !== null && VERIFIED_STATUSES.includes(idea.verificationStatus))
    .map((idea) => idea.selfInfo);
  const stdVerified = verifiedSi.length >= 1 ? pstdev(verifiedSi) : null;

  return makeEntropyMetrics({
    clusterEntropy: entropy,
    clusterEntropyNorm: entropyNorm,
    meanSelfInfo: meanSi,
    stdSelfInfo: sigmaSi,
    fluencyControlledOriginality: fco,
    stdSelfInfoVerified: stdVerified,
    degraded: ledger.degraded ?? false,
  });
}

/** 1 - cos(centroid(round0 A), centroid(round0 B)); < δ_open → re-seed (P9). */
export function openingDiversity(ledger: LedgerLike): number {
  const a = ledger
    .round0('A')
    .filter((i) => i.embedding && i.embedding.length > 0)
    .map((i) => i.embedding as number[]);
  const b = ledger
    .round0('B')
    .filter((i) => i.embedding && i.embedding.length > 0)
    .map((i) => i.embedding as number[]);
  if (a.length === 0 || b.length === 0) {
    return 1.0; // cannot measure → no spurious re-seed
  }
  return 1.0 - cos(centroid(a), centroid(b));
}

export function openingDiversityBelowFloor(ledger: LedgerLike, deltaOpen: number = DELTA_OPEN): boolean {
  return openingDiversity(ledger) < deltaOpen;
}

/** Cross-agent centroid convergence jump without an intervening attack (P14). */
export function fixationCheck(ledger: LedgerLike, roundNumber: number): boolean {
  const crossSim = (r: number): number | null => {
    const a = ledger
      .roundIdeas(r, 'A')
      .filter((i) => i.embedding && i.embedding.length > 0)
      .map((i) => i.embedding as number[]);
    const b = ledger
      .roundIdeas(r, 'B')
      .filter((i) => i.embedding && i.embedding.length > 0)
      .map((i) => i.embedding as number[]);
    if (a.length === 0 || b.length === 0) {
      return null;
    }
    return cos(centroid(a), centroid(b));
  };

  const cur = crossSim(roundNumber);
  const prev = crossSim(roundNumber - 1);
  if (cur === null || prev === null) {
    return false;
  }
  return cur - prev > FIXATION_JUMP;
}

// ---------------------------------------------------------------------------
// v2.1 — capture / verification telemetry (all SECONDARY to σ_SI)
// ---------------------------------------------------------------------------

export function verificationPassRate(insights: InsightRecord[]): number {
  if (insights.length === 0) {
    return 0.0;
  }
  let verified = 0;
  for (const i of insights) {
    if (VERIFIED_STATUSES.includes(i.status)) {
      verified += 1;
    }
  }
  return verified / insights.length;
}

export function captureCoverage(capturedCount: number, kTarget: number | null): number {
  if (!kTarget || kTarget <= 0) {
    return 0.0;
  }
  return Math.min(1.0, capturedCount / kTarget);
}

/**
 * Capture–recapture (Chapman) estimate — P2 TELEMETRY ONLY, never a gate.
 *
 * Unsound for correlated NLP extractors (THEORY §7.13); exported for diagnostics.
 */
export function estimatedRecall(nPass1: number, nPass2: number, overlap: number): number | null {
  if (nPass1 <= 0 || nPass2 <= 0) {
    return null;
  }
  const nHat = ((nPass1 + 1) * (nPass2 + 1)) / (overlap + 1) - 1;
  const union = nPass1 + nPass2 - overlap;
  if (nHat <= 0) {
    return null;
  }
  return Math.min(1.0, union / nHat);
}

export function coverageReport(
  ledger: LedgerLike,
  kTarget: number | null = null,
  omissionPassCount = 0,
  goldSetRecall: number | null = null,
  estimated: number | null = null,
): CoverageReport {
  const captured = ledger.insights.length;
  return makeCoverageReport({
    kTarget,
    capturedUnionCount: captured,
    coverage: captureCoverage(captured, kTarget),
    omissionPassCount,
    estimatedRecall: estimated, // P2 telemetry
    goldSetRecall, // the one honest number (M4)
  });
}
