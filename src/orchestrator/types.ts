// types.ts (N5) — BrainStrom orchestration data model.
//
// Schemas for the pool layer that sits above the Unit Cell engine: knowledge
// points (two kinds — atomic + cross-cutting lenses, Flaw 2), a dependency DAG,
// debate seats & roles (incl. the three logical moderator roles, Flaw 1),
// debate-mode presets over existing engine knobs (Flaw 6 / honesty: presets, not
// new science), per-group interim conclusions, group results, streaming events,
// and session state.
//
// Naming map (Python @dataclass -> TS): pure-data dataclasses become an interface
// plus a makeX(partial?) factory reproducing the defaults; dataclasses that had
// methods become classes; snake_case fields become camelCase. Enums -> const
// objects with byte-identical string values.

import { RigorTier } from '../engine/types';

// --------------------------------------------------------------------------- enums

export const DebateMode = {
  GAME_THEORETIC: 'game-theoretic',
  CRITICAL: 'critical',
  HEURISTIC: 'heuristic',
  MIXED: 'mixed',
} as const;
export type DebateMode = (typeof DebateMode)[keyof typeof DebateMode];

export const PointKind = {
  ATOMIC: 'atomic', // a single debatable proposition
  LENS: 'lens', // a cross-cutting theme/lens spanning several points (Flaw 2)
} as const;
export type PointKind = (typeof PointKind)[keyof typeof PointKind];

export const EdgeKind = {
  REQUIRES: 'requires', // hard edge: src must complete before dst (sequential)
  INFORMS: 'informs', // soft edge: pass src's interim as quarantined context to dst
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export const PairingPolicy = {
  PAIR_PER_POINT: 'pair-per-point', // default: 2 seats debate each point
  ALL_PAIRS: 'all-pairs-per-point', // high cost: every model pair per point
  TOURNAMENT: 'tournament-per-point', // future
} as const;
export type PairingPolicy = (typeof PairingPolicy)[keyof typeof PairingPolicy];

// Three logical moderator roles (Flaw 1) — may share one model in v0.1, but
// provenance records which role + family acted, and verification prefers a
// different family (LD8).
export const LogicalRole = {
  INTAKE_MODERATOR: 'intake_moderator',
  GROUP_JUDGE: 'group_judge',
  CHIEF_SCRIBE: 'chief_scribe',
} as const;
export type LogicalRole = (typeof LogicalRole)[keyof typeof LogicalRole];

// --------------------------------------------------------------------------- points + DAG

export interface KnowledgePoint {
  id: string;
  text: string;
  kind: string;
  rationale: string;
}

export function makeKnowledgePoint(partial: Partial<KnowledgePoint> & { id: string; text: string }): KnowledgePoint {
  return { kind: PointKind.ATOMIC, rationale: '', ...partial };
}

// ``dst`` depends on ``src`` (src is the prerequisite).
export interface DependencyEdge {
  src: string;
  dst: string;
  kind: string;
}

export function makeDependencyEdge(partial: Partial<DependencyEdge> & { src: string; dst: string }): DependencyEdge {
  return { kind: EdgeKind.INFORMS, ...partial };
}

export class KnowledgePointSet {
  points: KnowledgePoint[];
  edges: DependencyEdge[];

  constructor(points: KnowledgePoint[] = [], edges: DependencyEdge[] = []) {
    this.points = points;
    this.edges = edges;
  }

  private hardDeps(): Map<string, Set<string>> {
    const deps = new Map<string, Set<string>>();
    for (const p of this.points) {
      deps.set(p.id, new Set<string>());
    }
    for (const e of this.edges) {
      if (e.kind === EdgeKind.REQUIRES && deps.has(e.src) && deps.has(e.dst)) {
        deps.get(e.dst)!.add(e.src);
      }
    }
    return deps;
  }

  // Kahn layering over REQUIRES edges. Same-layer points run in parallel; later
  // layers run after their prerequisites (INFORMS edges do not gate order).
  // Returns the layers found; on a cycle, the cyclic remainder is omitted.
  topoLayers(): string[][] {
    const deps = this.hardDeps();
    const remaining = new Set<string>(deps.keys());
    const placed = new Set<string>();
    const layers: string[][] = [];
    while (remaining.size > 0) {
      const layer = Array.from(remaining)
        .filter((n) => isSubset(deps.get(n)!, placed))
        .sort();
      if (layer.length === 0) {
        break; // cycle among the remaining nodes
      }
      layers.push(layer);
      for (const n of layer) {
        placed.add(n);
        remaining.delete(n);
      }
    }
    return layers;
  }

  hasCycle(): boolean {
    const placed = this.topoLayers().reduce((acc, layer) => acc + layer.length, 0);
    return placed !== this.points.length;
  }

  // Return a list of problems (empty == valid). Used before CONFIRM_PLAN (F6).
  validate(): string[] {
    const problems: string[] = [];
    const ids = this.points.map((p) => p.id);
    const idset = new Set<string>(ids);
    if (ids.length !== idset.size) {
      problems.push('duplicate knowledge-point ids');
    }
    if (this.points.length < 2) {
      problems.push('need at least 2 knowledge points (decomposition floor)');
    }
    for (const p of this.points) {
      if (!p.text.trim()) {
        problems.push(`point ${reprStr(p.id)} has empty text`);
      }
      if (p.kind !== PointKind.ATOMIC && p.kind !== PointKind.LENS) {
        problems.push(`point ${reprStr(p.id)} has invalid kind ${reprStr(p.kind)}`);
      }
    }
    for (const e of this.edges) {
      if (!idset.has(e.src) || !idset.has(e.dst)) {
        problems.push(`edge ${e.src}->${e.dst} references unknown point`);
      }
      if (e.kind !== EdgeKind.REQUIRES && e.kind !== EdgeKind.INFORMS) {
        problems.push(`edge ${e.src}->${e.dst} has invalid kind ${reprStr(e.kind)}`);
      }
    }
    if (this.hasCycle()) {
      problems.push('dependency cycle among REQUIRES edges (must be resolved before CONFIRM_PLAN)');
    }
    return problems;
  }

  // All upstream point ids (both REQUIRES and INFORMS) for context passing.
  predecessors(pointId: string): string[] {
    const out = new Set<string>();
    for (const e of this.edges) {
      if (e.dst === pointId) {
        out.add(e.src);
      }
    }
    return Array.from(out).sort();
  }
}

// --------------------------------------------------------------------------- seats + roles

export interface SeatConfig {
  seatId: string;
  connectorId: string;
  model: string;
  role: string; // agentA | agentB | judge | harvester
  persona: string;
  temperature: number;
  family: string;
  order: number;
  criticizeFirst: boolean; // opening-order tendency (Thue-Morse, not a hard pin)
  critiqueHarder: boolean; // colder temp + REBUT/UNDERCUT bias
  collectsReport: boolean; // binds the judge-generative + harvester (collector/scribe)
}

export function makeSeatConfig(
  partial: Partial<SeatConfig> & { seatId: string; connectorId: string; model: string },
): SeatConfig {
  return {
    role: 'agentA',
    persona: '',
    temperature: 0.7,
    family: 'unknown',
    order: 0,
    criticizeFirst: false,
    critiqueHarder: false,
    collectsReport: false,
    ...partial,
  };
}

export class RoleMap {
  agentA: SeatConfig;
  agentB: SeatConfig;
  judge: SeatConfig;
  harvester: SeatConfig | null;
  // >2 debater seats → "panel" mode (multiDebate.runPanel). When unset or <2, the
  // group uses the two-agent Unit Cell engine via agentA/agentB.
  debaters: SeatConfig[] | null;

  constructor(args: {
    agentA: SeatConfig;
    agentB: SeatConfig;
    judge: SeatConfig;
    harvester?: SeatConfig | null;
    debaters?: SeatConfig[] | null;
  }) {
    this.agentA = args.agentA;
    this.agentB = args.agentB;
    this.judge = args.judge;
    this.harvester = args.harvester ?? null;
    this.debaters = args.debaters ?? null;
  }

  debaterSeats(): SeatConfig[] {
    if (this.debaters && this.debaters.length >= 2) {
      return this.debaters;
    }
    return [this.agentA, this.agentB];
  }
}

export interface GroupSpec {
  groupId: string;
  point: KnowledgePoint;
  mode: string;
  roleMap: RoleMap | null;
  predecessors: string[];
  sessionId: string;
  // Quarantined "prior claims" from upstream groups (Flaw 3) — injected as
  // background-not-truth context for downstream (dependent) groups.
  priorContext: string;
}

export function makeGroupSpec(partial: Partial<GroupSpec> & { groupId: string; point: KnowledgePoint }): GroupSpec {
  return {
    mode: DebateMode.MIXED,
    roleMap: null,
    predecessors: [],
    sessionId: '',
    priorContext: '',
    ...partial,
  };
}

// --------------------------------------------------------------------------- results + events

export interface InterimConclusion {
  groupId: string;
  pointId: string;
  summary: string;
  validatedKeyPoints: string[];
  candidateInsights: string[];
  evidenceStatus: string; // grounded | candidates-only | inconclusive
  sigmaSi: number | null; // DIVERSITY signal (not a quality score)
  composite: number | null;
  participation: string[]; // which model families debated (F9)
  degraded: boolean;
}

export function makeInterimConclusion(
  partial: Partial<InterimConclusion> & { groupId: string; pointId: string; summary: string },
): InterimConclusion {
  return {
    validatedKeyPoints: [],
    candidateInsights: [],
    evidenceStatus: 'inconclusive',
    sigmaSi: null,
    composite: null,
    participation: [],
    degraded: false,
    ...partial,
  };
}

export function interimConclusionToDict(c: InterimConclusion): Record<string, unknown> {
  return { ...c };
}

export interface GroupResult {
  groupId: string;
  interim: InterimConclusion | null;
  unitResult: unknown | null; // the full UnitResult (kept in-memory)
  error: string | null;
}

export function makeGroupResult(partial: Partial<GroupResult> & { groupId: string }): GroupResult {
  return { interim: null, unitResult: null, error: null, ...partial };
}

export interface GroupEvent {
  groupId: string;
  kind: string; // group.start | group.phase | group.interim | group.error
  payload: Record<string, unknown>;
  sessionId: string;
}

export function makeGroupEvent(partial: Partial<GroupEvent> & { groupId: string; kind: string }): GroupEvent {
  return { payload: {}, sessionId: '', ...partial };
}

export function groupEventToDict(e: GroupEvent): Record<string, unknown> {
  return { group_id: e.groupId, kind: e.kind, payload: e.payload, session_id: e.sessionId };
}

export interface SessionState {
  sessionId: string;
  topic: string;
  mode: string;
  pointSet: KnowledgePointSet | null;
  results: GroupResult[];
  status: string; // intake | confirm_plan | running | done | error
}

export function makeSessionState(partial: Partial<SessionState> & { sessionId: string; topic: string }): SessionState {
  return {
    mode: DebateMode.MIXED,
    pointSet: null,
    results: [],
    status: 'intake',
    ...partial,
  };
}

// The final aggregated artifact (chief scribe, N10). Markdown is the savable
// output; the structured fields back it and the honest metrics summary.
export interface BrainstormReport {
  domain: string;
  mode: string;
  markdown: string;
  validatedKeyPoints: string[];
  candidateInsights: string[];
  perPoint: Record<string, unknown>[];
  groupsRun: number;
  groupsFailed: number;
}

export function makeBrainstormReport(
  partial: Partial<BrainstormReport> & { domain: string; mode: string; markdown: string },
): BrainstormReport {
  return {
    validatedKeyPoints: [],
    candidateInsights: [],
    perPoint: [],
    groupsRun: 0,
    groupsFailed: 0,
    ...partial,
  };
}

export function brainstormReportToDict(r: BrainstormReport): Record<string, unknown> {
  return { ...r };
}

// --------------------------------------------------------------------------- mode presets (Flaw 6)

export interface ModeProfile {
  maxRounds: number;
  proposeClashSplit: [number, number];
  objective: string;
  rigorTier: RigorTier;
  generatorTemp: number;
  verifierTemp: number;
}

// Map a debate mode to UnitConfig knob overrides.
//
// HONESTY: these are PRESETS over existing engine knobs, not new science; the
// ``objective`` string is a LABEL the engine does not act on. Mirrors the
// canonical table in CONSTITUTION §7 (Algorithms).
export function modeProfile(mode: string, pointKind: string = PointKind.ATOMIC): ModeProfile {
  let m = mode;
  if (m === DebateMode.MIXED) {
    // Route by point kind: lenses favor broad ideation; atomic points favor critique.
    m = pointKind === PointKind.LENS ? DebateMode.HEURISTIC : DebateMode.CRITICAL;
  }
  const table: Record<string, ModeProfile> = {
    [DebateMode.CRITICAL]: {
      maxRounds: 4,
      proposeClashSplit: [0.4, 0.6],
      objective: 'assumptions-overturned',
      rigorTier: RigorTier.STANDARD,
      generatorTemp: 0.7,
      verifierTemp: 0.2,
    },
    [DebateMode.HEURISTIC]: {
      maxRounds: 4,
      proposeClashSplit: [0.65, 0.35],
      objective: 'sigma_si-diversity+good-idea-count',
      rigorTier: RigorTier.STANDARD,
      generatorTemp: 0.9,
      verifierTemp: 0.2,
    },
    [DebateMode.GAME_THEORETIC]: {
      maxRounds: 4,
      proposeClashSplit: [0.5, 0.5],
      objective: 'validity-under-verification',
      rigorTier: RigorTier.HIGH_STAKES,
      generatorTemp: 0.4,
      verifierTemp: 0.2,
    },
  };
  const entry = table[m];
  if (entry === undefined) {
    // Mirrors Python DebateMode(mode) raising on an unknown mode value.
    throw new Error(`${reprStr(mode)} is not a valid DebateMode`);
  }
  return { ...entry, proposeClashSplit: [entry.proposeClashSplit[0], entry.proposeClashSplit[1]] };
}

// --------------------------------------------------------------------------- internal helpers

function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  for (const v of sub) {
    if (!sup.has(v)) {
      return false;
    }
  }
  return true;
}

// Python repr() for a string: single-quoted. Used only in validate() messages.
function reprStr(s: string): string {
  return `'${s}'`;
}
