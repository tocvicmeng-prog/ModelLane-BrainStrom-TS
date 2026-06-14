// chiefScribe.ts (N10) — cross-group aggregation into one honest report.
//
// Deduplicates validated key points across groups, presents (does not auto-resolve)
// disagreement, surfaces flagged candidates, and renders a Markdown report whose
// STRUCTURE enforces uncertainty (Flaw 5): executive synthesis -> decomposition map ->
// per-point conclusions in topological order (each with a mandatory Flagged-candidates
// block) -> cross-cutting findings -> "What we are NOT sure about" -> provenance & metrics.
// Honesty: sigma_SI is a DIVERSITY signal (not quality); "validated" = survived scrutiny
// (not proven true); token/cost numbers are estimates.

import {
  BrainstormReport,
  DependencyEdge,
  GroupEvent,
  GroupResult,
  InterimConclusion,
  KnowledgePoint,
  KnowledgePointSet,
  makeBrainstormReport,
  makeGroupEvent,
} from './types';

// AgentClient-shaped scribe: only speak() is used here.
export interface ScribeLike {
  speak(messages: { role: string; content: string }[]): Promise<string>;
}

export type EmitFn = (event: GroupEvent) => void;

// Internal per-point record (camelCase keys; structurally a Record<string, unknown>
// so it slots straight into BrainstormReport.perPoint). Status "failed" records carry
// an error; otherwise the interim-derived fields are present.
interface PerPoint {
  id: string;
  text: string;
  kind: string;
  status: string;
  error?: string | null;
  summary?: string;
  validated?: string[];
  candidates?: string[];
  sigmaSi?: number | null;
  composite?: number | null;
  participation?: string[];
}

const EXEC_PROMPT =
  "Write a 2-3 sentence executive synthesis of a brainstorm on '{domain}'. Grounded " +
  'points: {points}. Be honest and do not overstate certainty.';

function norm(text: string): string {
  return text.toLowerCase().split(/\s+/).filter((w) => w.length > 0).join(' ');
}

function fmt(x: number | null | undefined): string {
  return typeof x === 'number' ? x.toFixed(3) : 'n/a';
}

export async function aggregate(
  domain: string,
  mode: string,
  pointSet: KnowledgePointSet,
  results: GroupResult[],
  opts: { scribe?: ScribeLike | null; emit?: EmitFn | null; sessionId?: string } = {},
): Promise<BrainstormReport> {
  const scribe = opts.scribe ?? null;
  const emit = opts.emit ?? null;
  const sessionId = opts.sessionId ?? '';

  const byId = new Map<string, KnowledgePoint>(pointSet.points.map((p) => [p.id, p]));
  const layers = pointSet.topoLayers();
  const order: string[] = [];
  for (const layer of layers) {
    for (const pid of layer) {
      order.push(pid);
    }
  }
  const orderSet = new Set<string>(order);
  for (const p of pointSet.points) {
    if (!orderSet.has(p.id)) {
      order.push(p.id);
    }
  }
  const resByPoint = new Map<string, GroupResult>(results.map((r) => [r.groupId, r]));

  const validated: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  const perPoint: PerPoint[] = [];
  let groupsRun = 0;
  let groupsFailed = 0;

  for (const pid of order) {
    const r = resByPoint.get(pid);
    if (r === undefined) {
      continue;
    }
    const p = byId.get(pid);
    if (r.error || r.interim === null) {
      groupsFailed += 1;
      perPoint.push({
        id: pid,
        text: p ? p.text : pid,
        kind: p ? p.kind : 'atomic',
        status: 'failed',
        error: r.error,
      });
      continue;
    }
    groupsRun += 1;
    const it: InterimConclusion = r.interim;
    for (const kp of it.validatedKeyPoints) {
      const k = norm(kp);
      if (!seen.has(k)) {
        seen.add(k);
        validated.push(kp);
      }
    }
    for (const c of it.candidateInsights) {
      candidates.push(c);
    }
    perPoint.push({
      id: pid,
      text: p ? p.text : pid,
      kind: p ? p.kind : 'atomic',
      status: it.evidenceStatus,
      summary: it.summary,
      validated: it.validatedKeyPoints,
      candidates: it.candidateInsights,
      sigmaSi: it.sigmaSi,
      composite: it.composite,
      participation: it.participation,
    });
  }

  let execSummary = '';
  if (scribe !== null && validated.length > 0) {
    try {
      const reply = await scribe.speak([
        {
          role: 'user',
          // Single-pass replace via a function so `$`-sequences in the domain/points
          // text are NOT interpreted and a literal "{points}" in the domain cannot bleed.
          content: EXEC_PROMPT.replace(/\{domain\}|\{points\}/g, (m) =>
            m === '{domain}' ? domain : validated.slice(0, 8).join('; ')),
        },
      ]);
      execSummary = reply.trim();
    } catch {
      execSummary = '';
    }
  }

  const markdown = render(
    domain,
    mode,
    pointSet,
    order,
    byId,
    perPoint,
    validated,
    candidates,
    execSummary,
    groupsRun,
    groupsFailed,
  );
  if (emit !== null) {
    emit(
      makeGroupEvent({
        groupId: 'session',
        kind: 'aggregate.progress',
        payload: { stage: 'done', groups_run: groupsRun, groups_failed: groupsFailed },
        sessionId,
      }),
    );
  }
  return makeBrainstormReport({
    domain,
    mode,
    markdown,
    validatedKeyPoints: validated,
    candidateInsights: candidates,
    perPoint: perPoint as unknown as Record<string, unknown>[],
    groupsRun,
    groupsFailed,
  });
}

function render(
  domain: string,
  mode: string,
  pointSet: KnowledgePointSet,
  order: string[],
  byId: Map<string, KnowledgePoint>,
  perPoint: PerPoint[],
  validated: string[],
  candidates: string[],
  execSummary: string,
  groupsRun: number,
  groupsFailed: number,
): string {
  const out: string[] = [];
  out.push(
    '---',
    `title: BrainStrom report — ${domain}`,
    `mode: ${mode}`,
    `groups_run: ${groupsRun}`,
    `groups_failed: ${groupsFailed}`,
    '---',
    '',
  );
  out.push(`# Brainstorm: ${domain}`, '');

  out.push('## Executive synthesis', '');
  out.push(execSummary || '_(mechanical summary — no scribe model configured)_', '');

  out.push('## Decomposition map', '');
  for (const pid of order) {
    const p = byId.get(pid);
    if (p) {
      out.push(`- **${pid}** [${p.kind}] ${p.text}`);
    }
  }
  if (pointSet.edges.length > 0) {
    out.push('', 'Dependencies:');
    for (const e of pointSet.edges) {
      const edge: DependencyEdge = e;
      out.push(`- ${edge.src} → ${edge.dst} (${edge.kind})`);
    }
  }
  out.push('');

  out.push('## Per-point conclusions (topological order)', '');
  for (const pp of perPoint) {
    out.push(`### ${pp.id} — ${pp.text}  _(${pp.status})_`);
    if (pp.status === 'failed') {
      // Python prints f"{error}", which renders None as the literal "None".
      out.push(`- ⚠️ group failed: ${pp.error ?? 'None'}`, '');
      continue;
    }
    if (pp.summary) {
      out.push(pp.summary, '');
    }
    if (pp.validated && pp.validated.length > 0) {
      out.push('**Validated key points:**');
      for (const v of pp.validated) {
        out.push(`- ${v}`);
      }
    }
    out.push('**Flagged candidates (unverified — kept, not dropped):**');
    if (pp.candidates && pp.candidates.length > 0) {
      for (const c of pp.candidates) {
        out.push(`- ${c}`);
      }
    } else {
      out.push('- _(none)_');
    }
    // Mirror Python's `', '.join(...) or 'n/a'`: fall back on an EMPTY joined string
    // (e.g. participation === ['']), not merely on an empty list.
    const joinedParticipation = (pp.participation ?? []).join(', ');
    const participation = joinedParticipation.length > 0 ? joinedParticipation : 'n/a';
    out.push(
      `_metrics: σ_SI (diversity)=${fmt(pp.sigmaSi)}, ` +
        `composite=${fmt(pp.composite)}; ` +
        `participation=${participation}_`,
      '',
    );
  }

  out.push('## Cross-cutting findings', '', 'Deduplicated validated key points across all groups:');
  if (validated.length > 0) {
    for (const v of validated) {
      out.push(`- ${v}`);
    }
  } else {
    out.push('- _(none reached grounded status)_');
  }
  out.push('');

  out.push('## What we are NOT sure about', '');
  if (candidates.length > 0) {
    for (const c of candidates) {
      out.push(`- ${c}`);
    }
  } else {
    out.push('- _(no flagged candidates)_');
  }
  out.push('');

  out.push(
    '## Provenance & metrics',
    '',
    `- groups run: ${groupsRun}; failed: ${groupsFailed}`,
    '- σ_SI is a DIVERSITY signal, not a quality score; "validated" = survived ' +
      'scrutiny, not proven true; token/cost figures are estimates.',
  );
  return out.join('\n');
}
