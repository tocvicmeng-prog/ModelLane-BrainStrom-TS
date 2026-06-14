// scheduler.ts (N9) — DAG -> waves, parallel within a layer, sequential across layers.
//
// Runs each topological layer's groups concurrently (Promise.all, capped by
// maxConcurrency), then moves to the next layer, passing each downstream group its
// predecessors' interims as a QUARANTINED "prior claims" block (Flaw 3,
// anti-fixation). An absolute token budget governor stops scheduling new groups once
// the cap is reached (cost-DoS control, R-COST/S9). `runOne(pointId, priorContext)
// -> GroupResult` is injected so the scheduler is testable without real LLMs; the
// production factory builds fresh egress-guarded clients per group.

import { quarantinePriorClaims } from './security';
import {
  GroupEvent,
  GroupResult,
  KnowledgePointSet,
  makeGroupEvent,
  makeGroupResult,
} from './types';

// Injected per-group runner. May be sync or async; the scheduler awaits it either way.
export type RunOne = (pointId: string, priorContext: string) => GroupResult | Promise<GroupResult>;

// Emit sink for session-level streaming events.
export type EmitFn = (event: GroupEvent) => void;

// Absolute per-session token ceiling, independent of any per-group budget.
export class BudgetGovernor {
  maxTotalTokens: number | null;
  spent: number;

  constructor(maxTotalTokens: number | null = null, spent = 0) {
    this.maxTotalTokens = maxTotalTokens;
    this.spent = spent;
  }

  charge(tokens: number): void {
    this.spent += Math.max(0, tokens);
  }

  exhausted(): boolean {
    return this.maxTotalTokens !== null && this.spent >= this.maxTotalTokens;
  }
}

export interface RunSessionOptions {
  emit?: EmitFn | null;
  sessionId?: string;
  maxConcurrency?: number;
  budget?: BudgetGovernor | null;
}

// Execute every point's group in dependency order; return results in point order.
export async function runSession(
  pointSet: KnowledgePointSet,
  runOne: RunOne,
  options: RunSessionOptions = {},
): Promise<GroupResult[]> {
  const emit = options.emit ?? null;
  const sessionId = options.sessionId ?? '';
  const maxConcurrency = options.maxConcurrency ?? 4;
  const budget = options.budget ?? null;

  const _emit = (kind: string, payload: Record<string, unknown>): void => {
    if (emit !== null) {
      emit(makeGroupEvent({ groupId: 'session', kind, payload, sessionId }));
    }
  };

  const layers = pointSet.topoLayers();
  // Any points excluded by an unresolved (soft) cycle still get one final layer.
  const placed = new Set<string>();
  for (const layer of layers) {
    for (const pid of layer) {
      placed.add(pid);
    }
  }
  const leftover = pointSet.points.filter((p) => !placed.has(p.id)).map((p) => p.id);
  if (leftover.length > 0) {
    layers.push(leftover);
  }

  _emit('schedule.plan', {
    layers,
    points: pointSet.points.map((p) => ({ id: p.id, kind: p.kind })),
  });

  const results = new Map<string, GroupResult>();
  for (const layer of layers) {
    if (budget !== null && budget.exhausted()) {
      _emit('budget', {
        stopped: true,
        reason: 'absolute token budget exhausted',
        spent: budget.spent,
      });
      break;
    }

    // Build each point's quarantined predecessor context from completed upstream interims.
    const tasks: Array<[string, string]> = [];
    for (const pid of layer) {
      const parts: string[] = [];
      for (const src of pointSet.predecessors(pid)) {
        const r = results.get(src);
        if (r && r.interim && r.interim.summary) {
          parts.push(quarantinePriorClaims(r.interim.summary, src));
        }
      }
      tasks.push([pid, parts.join('\n\n')]);
    }

    const workers = Math.max(1, Math.min(maxConcurrency, tasks.length));
    // Parallel within the layer, capped at `workers`. Final ordering is rebuilt in
    // point order below, and budget charging is additive, so completion order does
    // not affect the result (mirrors as_completed + thread pool).
    await runLayer(tasks, runOne, workers, (pid, res) => {
      results.set(pid, res);
      if (budget !== null && res.unitResult !== null) {
        const total = (res.unitResult as { totalTokens?: number }).totalTokens ?? 0;
        budget.charge(total || 0);
      }
    });
  }

  return pointSet.points.filter((p) => results.has(p.id)).map((p) => results.get(p.id)!);
}

// Run one layer's tasks with a bounded number of concurrent workers, isolating each
// group's failure into a GroupResult.error (mirrors the per-future try/except).
async function runLayer(
  tasks: Array<[string, string]>,
  runOne: RunOne,
  workers: number,
  onDone: (pid: string, res: GroupResult) => void,
): Promise<void> {
  let next = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= tasks.length) {
        return;
      }
      const [pid, prior] = tasks[idx];
      let res: GroupResult;
      try {
        res = await runOne(pid, prior);
      } catch (exc) {
        // Isolate a group failure.
        res = makeGroupResult({
          groupId: pid,
          interim: null,
          unitResult: null,
          error: exc instanceof Error ? exc.message : String(exc),
        });
      }
      onDone(pid, res);
    }
  };

  const pool: Array<Promise<void>> = [];
  for (let i = 0; i < workers; i++) {
    pool.push(runWorker());
  }
  await Promise.all(pool);
}
