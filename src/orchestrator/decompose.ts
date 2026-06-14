// decompose.ts (N7) — bespoke decomposition (NOT a UnitEngine.run()).
//
// Turns a user DOMAIN into a set of debatable knowledge points + a dependency DAG.
// It deliberately does NOT inherit Unit Cell guarantees (it is a lightweight propose
// → dedup → rank → edges → resolve-cycles workflow), so its budget/streaming/security
// are its own (ARCHITECTURE F6). Two point kinds are emitted — atomic propositions AND
// cross-cutting lenses (Flaw 2) — to preserve useful ambiguity. All model output is
// treated as DATA: injected text is isolated/skipped, never executed (F11). Cycles are
// resolved BEFORE the result is returned so the plan shown at CONFIRM_PLAN is acyclic
// and equals what will execute.

import { extractJson } from '../engine/agent';
import { ChatMessage } from '../engine/types';
import { detectInjection } from './security';
import {
  DependencyEdge,
  EdgeKind,
  KnowledgePoint,
  KnowledgePointSet,
  PointKind,
  makeDependencyEdge,
  makeGroupEvent,
  makeKnowledgePoint,
} from './types';

// Duck-typed LLM client: anything with an async `speak` (AgentClient or a test fake).
export interface SpeakerLike {
  speak(conversation: ChatMessage[], temperature?: number): Promise<string>;
}

// decompose event sink — receives a GroupEvent-shaped record.
export type DecomposeEmit = (event: ReturnType<typeof makeGroupEvent>) => void;

export const PROPOSE_PROMPT =
  'You break a brainstorming DOMAIN into debatable knowledge points. Output ONLY a ' +
  'JSON array; each item {"text": "<one debatable proposition>", "kind": ' +
  '"atomic"|"lens", "rationale": "<short>"}. "atomic" = a single sharply-debatable ' +
  'claim; "lens" = a cross-cutting theme spanning several points. Make points ' +
  'distinct, material, and genuinely arguable.\n\nDOMAIN: {domain}\n';

export const EDGES_PROMPT =
  'Given these knowledge points (JSON), output ONLY a JSON array of dependency edges ' +
  '{"src": "<id>", "dst": "<id>", "kind": "requires"|"informs"} where dst depends ' +
  'on src ("requires" = debate src first; "informs" = src context helps dst). Use ' +
  'only the given ids and introduce no cycles.\n\nPOINTS: {points}\n';

function norm(text: string): string {
  return text.toLowerCase().split(/\s+/).filter((w) => w).join(' ');
}

export interface DecomposeOptions {
  proposers: SpeakerLike[];
  moderator?: SpeakerLike | null;
  maxPoints?: number;
  emit?: DecomposeEmit | null;
  sessionId?: string;
}

// Return a validated, acyclic KnowledgePointSet for `domain`.
//
// `proposers` and `moderator` are duck-typed LLM clients (`.speak` -> Promise<str>);
// tests pass fakes that return canned JSON. `emit` receives decompose events.
export async function decompose(domain: string, opts: DecomposeOptions): Promise<KnowledgePointSet> {
  const proposers = opts.proposers;
  const moderator = opts.moderator ?? null;
  const maxPoints = opts.maxPoints ?? 6;
  const emit = opts.emit ?? null;
  const sessionId = opts.sessionId ?? '';

  const doEmit = (kind: string, payload: Record<string, unknown>): void => {
    if (emit !== null) {
      emit(makeGroupEvent({ groupId: 'decompose', kind, payload, sessionId }));
    }
  };

  // 1. ENUMERATE — each proposer suggests points.
  const raw: Record<string, unknown>[] = [];
  for (let i = 0; i < proposers.length; i++) {
    const pr = proposers[i];
    doEmit('decompose.progress', { stage: 'enumerate', proposer: i });
    let out: string;
    try {
      out = await pr.speak([{ role: 'user', content: PROPOSE_PROMPT.replace('{domain}', domain) }]);
    } catch {
      // one proposer failing must not abort decomposition
      continue;
    }
    const parsed = extractJson(out);
    if (Array.isArray(parsed)) {
      for (const x of parsed) {
        if (isPlainObject(x)) {
          raw.push(x);
        }
      }
    }
  }

  // 2. DEDUP + sanitize (injected text is isolated, never made a point — F11).
  const seen = new Set<string>();
  const points: KnowledgePoint[] = [];
  for (const item of raw) {
    const text = String(item.text ?? '').trim();
    if (!text) {
      continue;
    }
    if (detectInjection(text)) {
      doEmit('decompose.progress', { stage: 'rejected-injection' });
      continue;
    }
    const key = norm(text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const kind =
      String(item.kind ?? '').toLowerCase() === 'lens' ? PointKind.LENS : PointKind.ATOMIC;
    points.push(
      makeKnowledgePoint({
        id: `p${points.length + 1}`,
        text: text.slice(0, 300),
        kind,
        rationale: String(item.rationale ?? '').slice(0, 300),
      }),
    );
    if (points.length >= maxPoints) {
      break;
    }
  }

  const pset = new KnowledgePointSet(points, []);

  // 3. EDGES — ask the moderator for a dependency DAG (optional).
  if (moderator !== null && points.length >= 2) {
    doEmit('decompose.progress', { stage: 'edges' });
    const ids = new Set<string>(points.map((p) => p.id));
    let parsed: unknown = null;
    try {
      const out = await moderator.speak([
        {
          role: 'user',
          content: EDGES_PROMPT.replace(
            '{points}',
            JSON.stringify(points.map((p) => ({ id: p.id, text: p.text }))),
          ),
        },
      ]);
      parsed = extractJson(out);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (!isPlainObject(e)) {
          continue;
        }
        const src = e.src;
        const dst = e.dst;
        if (
          typeof src === 'string' &&
          typeof dst === 'string' &&
          ids.has(src) &&
          ids.has(dst) &&
          src !== dst
        ) {
          const kind =
            String(e.kind ?? '').toLowerCase() === 'requires' ? EdgeKind.REQUIRES : EdgeKind.INFORMS;
          pset.edges.push(makeDependencyEdge({ src, dst, kind }));
        }
      }
    }
  }

  // 4. Resolve cycles BEFORE returning (CONFIRM_PLAN must show the executed DAG).
  resolveCycles(pset, doEmit);

  doEmit('decompose.points', {
    points: pset.points.map((p) => ({ id: p.id, text: p.text, kind: p.kind })),
    edges: pset.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind })),
  });
  return pset;
}

// Drop REQUIRES edges (most-recently-added first) until the graph is acyclic.
export function resolveCycles(
  pset: KnowledgePointSet,
  emit: (kind: string, payload: Record<string, unknown>) => void,
): void {
  while (pset.hasCycle()) {
    const req = pset.edges.filter((e) => e.kind === EdgeKind.REQUIRES);
    if (req.length === 0) {
      break; // cycle is only among soft edges (which don't gate order) — nothing to drop
    }
    const dropped = req[req.length - 1];
    // Mirror Python list.remove: drop the FIRST value-equal edge.
    const idx = pset.edges.findIndex(
      (e) => e.src === dropped.src && e.dst === dropped.dst && e.kind === dropped.kind,
    );
    if (idx !== -1) {
      pset.edges.splice(idx, 1);
    }
    emit('decompose.progress', {
      stage: 'cycle-resolved',
      dropped: `${dropped.src}->${dropped.dst}`,
    });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Re-export the shared edge type so downstream imports can come from one place.
export type { DependencyEdge };
