// ledger.ts (N11) — Idea ledger with provenance, dedup, diversity, novelty.
//
// Holds every idea slip (PROPOSE) and — via ingestInsights (v2.1) — every harvested
// insight (PROPOSE/CLASH/RECOMMEND) in one unified pool so entropy/diversity see the
// whole picture. Similarity uses cosine over embeddings when present, else a lexical
// Jaccard fallback (so the ledger works degraded). Dedup at θ_dup makes the pool
// redundancy-invariant: a clone collapses into its original and cannot inflate counts.
//
// See ARCHITECTURE.md §2 (N11), §4.3 (MD/GIC terms), §4.12 (kpaCluster).

import { EmbeddingsClient } from './embeddings';
import {
  DEFAULT_CLUSTER_SIM,
  DEFAULT_THETA_DUP,
  DEFAULT_THETA_Q,
  IdeaRecord,
  IdeaStatus,
  InsightRecord,
  insightToIdeaRecord,
} from './types';

/** Structural minimum the similarity helper reads (IdeaRecord & InsightRecord both satisfy it). */
interface Similar {
  text: string;
  embedding: number[] | null;
}

export class IdeaLedger {
  embeddings: EmbeddingsClient | null;
  thetaDup: number;
  thetaQ: number;
  ideas: IdeaRecord[] = [];
  insights: InsightRecord[] = [];
  degraded = false;

  constructor(
    embeddings: EmbeddingsClient | null = null,
    thetaDup: number = DEFAULT_THETA_DUP,
    thetaQ: number = DEFAULT_THETA_Q,
  ) {
    this.embeddings = embeddings;
    this.thetaDup = thetaDup;
    this.thetaQ = thetaQ;
  }

  // -- embedding helper -------------------------------------------------
  private async ensureEmbeddings(records: Array<IdeaRecord | InsightRecord>): Promise<void> {
    if (this.embeddings === null) {
      return;
    }
    const missing = records.filter((r) => r.embedding === null && r.text);
    if (missing.length === 0) {
      return;
    }
    const vectors = await this.embeddings.embed(missing.map((r) => r.text));
    for (let i = 0; i < missing.length; i++) {
      missing[i]!.embedding = vectors[i]!;
    }
    if (this.embeddings.degraded) {
      this.degraded = true;
    }
  }

  private similarity(a: Similar, b: Similar): number {
    if (a.embedding !== null && b.embedding !== null) {
      return EmbeddingsClient.cosine(a.embedding, b.embedding);
    }
    return EmbeddingsClient.jaccard(a.text, b.text); // lexical fallback
  }

  // -- ingestion --------------------------------------------------------
  async ingest(slips: IdeaRecord[]): Promise<IdeaRecord[]> {
    await this.ensureEmbeddings(slips);
    this.ideas.push(...slips);
    return slips;
  }

  // (v2.1) Record harvested insights — the call that closes the CLASH leak.
  // Each insight is kept as an InsightRecord (verification provenance, candidate
  // export) AND mirrored into the unified idea pool so entropy/dedup see it too.
  async ingestInsights(insights: InsightRecord[]): Promise<InsightRecord[]> {
    await this.ensureEmbeddings(insights);
    for (const ins of insights) {
      this.insights.push(ins);
      this.ideas.push(insightToIdeaRecord(ins));
    }
    return insights;
  }

  // -- dedup (redundancy invariance) -----------------------------------
  // Merge near-duplicates among ACTIVE ideas. Returns the count merged.
  dedup(thetaDup: number | null = null): number {
    const theta = thetaDup === null ? this.thetaDup : thetaDup;
    const active = this.active();
    let merged = 0;
    let nextCluster = 0;
    for (let i = 0; i < active.length; i++) {
      const idea = active[i]!;
      if (idea.status !== IdeaStatus.ACTIVE) {
        continue;
      }
      if (idea.clusterId === null) {
        idea.clusterId = nextCluster;
        nextCluster += 1;
      }
      for (let k = 0; k < i; k++) {
        const earlier = active[k]!;
        if (earlier.status !== IdeaStatus.ACTIVE) {
          continue;
        }
        if (this.similarity(idea, earlier) >= theta) {
          idea.status = IdeaStatus.MERGED;
          idea.clusterId = earlier.clusterId;
          if (!idea.parentIds.includes(earlier.id)) {
            idea.parentIds.push(earlier.id);
          }
          merged += 1;
          break;
        }
      }
    }
    return merged;
  }

  // -- views ------------------------------------------------------------
  active(): IdeaRecord[] {
    return this.ideas.filter((i) => i.status === IdeaStatus.ACTIVE);
  }

  get n(): number {
    return this.active().length;
  }

  qualities(): number[] {
    return this.active().map((i) => i.quality);
  }

  byQualityDesc(): IdeaRecord[] {
    return [...this.active()].sort((a, b) => b.quality - a.quality);
  }

  roundIdeas(roundNumber: number, side: string | null = null): IdeaRecord[] {
    let out = this.active().filter((i) => i.roundNumber === roundNumber);
    if (side !== null) {
      out = out.filter((i) => i.agent === side);
    }
    return out;
  }

  round0(side: string): IdeaRecord[] {
    return this.roundIdeas(0, side);
  }

  // -- metrics tie-ins --------------------------------------------------
  goodIdeaCount(thetaQ: number | null = null): number {
    const theta = thetaQ === null ? this.thetaQ : thetaQ;
    return this.active().filter((i) => i.quality >= theta).length;
  }

  // MD = mean_i(1 - max_{j ranked earlier} cos(e_i, e_j)) over active ideas.
  // Computed over the *current* active set (call before dedup to observe a clone
  // dragging MD down; after dedup the clone is already removed).
  marginalDiversity(): number {
    const ranked = this.byQualityDesc();
    if (ranked.length === 0) {
      return 0.0;
    }
    const contribs: number[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const idea = ranked[i]!;
      if (i === 0) {
        contribs.push(1.0);
        continue;
      }
      let maxSim = -Infinity;
      for (let k = 0; k < i; k++) {
        const sim = this.similarity(idea, ranked[k]!);
        if (sim > maxSim) {
          maxSim = sim;
        }
      }
      contribs.push(1.0 - maxSim);
    }
    return contribs.reduce((s, c) => s + c, 0) / contribs.length;
  }

  // Fraction of a round's ingested ideas that survived dedup (stayed active).
  noveltyRate(roundNumber: number): number {
    const inRound = this.ideas.filter((i) => i.roundNumber === roundNumber);
    if (inRound.length === 0) {
      return 0.0;
    }
    const survived = inRound.filter((i) => i.status === IdeaStatus.ACTIVE).length;
    return survived / inRound.length;
  }

  // -- distillation helper (v2.1) --------------------------------------
  // Greedy leader clustering for Key Point Analysis (Bar-Haim 2020).
  // Returns clusters (each a list, leader first). Used by the two-tier distill.
  kpaCluster<T extends Similar>(records: T[], simThreshold: number = DEFAULT_CLUSTER_SIM): T[][] {
    const clusters: T[][] = [];
    const leaders: T[] = [];
    for (const rec of records) {
      let placed = false;
      for (let idx = 0; idx < leaders.length; idx++) {
        if (this.similarity(rec, leaders[idx]!) >= simThreshold) {
          clusters[idx]!.push(rec);
          placed = true;
          break;
        }
      }
      if (!placed) {
        leaders.push(rec);
        clusters.push([rec]);
      }
    }
    return clusters;
  }

  eligibleInsights(statuses: readonly string[]): InsightRecord[] {
    return this.insights.filter((i) => statuses.includes(i.status));
  }
}
