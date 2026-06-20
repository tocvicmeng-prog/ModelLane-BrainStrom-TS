import * as vscode from 'vscode';

/**
 * connectorRegistry.ts (N14) — the secret-FREE connector + seat catalog.
 *
 * Persists connector definitions (kind + base URL, never the key) and the three debate
 * seats (agent_a / agent_b / judge → the three logical roles) in globalState. Secrets
 * live only in SecretStorage (N13). `buildSessionParams` turns this config + a domain
 * into the `run.session` RPC params.
 */
export type ConnectorKind = 'openai' | 'anthropic' | 'openai-compatible' | 'cli';

export interface ConnectorDef {
  id: string;
  kind: ConnectorKind;
  baseUrl: string;
  // CLI-connector fields (kind === 'cli'): the command may be a string or argv array.
  command?: string | string[];
  promptVia?: 'stdin' | 'arg';
  timeout?: number;
  maxOutputChars?: number;
  cwd?: string;
  allowFileTools?: boolean;
}

export interface SeatDef {
  connectorId: string;
  model: string;
  family: string;
  persona?: string;
  temperature?: number;
  // An uploaded "skill file" (markdown, optionally with simple key: value front-matter)
  // whose content is combined into this seat's persona / system prompt (see composePersona).
  skill?: { name: string; content: string };
}

export interface BrainstormConfig {
  connectors: ConnectorDef[];
  // The three required seats, plus an optional debaters panel: >=3 debaters → the group
  // runs the N-way panel engine (multi_debate); <3 falls back to agent_a/agent_b.
  seats: { agent_a: SeatDef; agent_b: SeatDef; judge: SeatDef; debaters?: SeatDef[] };
  mode: string;            // game-theoretic | critical | heuristic | mixed
  maxPoints: number;
  maxTotalTokens?: number;
  researchEnabled: boolean;
}

const KEY = 'brainstrom.config.v1';

export function defaultConfig(): BrainstormConfig {
  const local: ConnectorDef = { id: 'local', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' };
  const seat = (family: string): SeatDef => ({ connectorId: 'local', model: 'local-model', family });
  return {
    connectors: [local],
    seats: { agent_a: seat('debater-a'), agent_b: seat('debater-b'), judge: seat('moderator') },
    mode: 'mixed',
    maxPoints: 5,
    researchEnabled: false,
  };
}

export class ConnectorRegistry {
  constructor(private readonly state: vscode.Memento) { }

  getConfig(): BrainstormConfig {
    return this.state.get<BrainstormConfig>(KEY) ?? defaultConfig();
  }

  async setConfig(cfg: BrainstormConfig): Promise<void> {
    await this.state.update(KEY, cfg);
  }
}

/** Build run.session RPC params. Remote connectors only get allow_remote when the user opted in. */
export function buildSessionParams(domain: string, cfg: BrainstormConfig, sessionId: string,
                                   allowRemote: boolean): Record<string, unknown> {
  const connectors = cfg.connectors.map(c => {
    const out: Record<string, unknown> = {
      id: c.id,
      kind: c.kind,
      base_url: c.baseUrl,
      // Local + CLI never need remote egress; remote APIs honor the user's opt-in.
      allow_remote: (c.kind === 'openai-compatible' || c.kind === 'cli') ? false : allowRemote,
    };
    if (c.kind === 'cli') {
      if (c.command) out.command = c.command;
      if (c.promptVia) out.prompt_via = c.promptVia;
      if (c.timeout) out.timeout = c.timeout;
      if (c.maxOutputChars) out.max_output_chars = c.maxOutputChars;
      if (c.cwd) out.cwd = c.cwd;
      out.allow_file_tools = !!c.allowFileTools;
    }
    return out;
  });
  const seat = (s: SeatDef, role: string) => ({
    connector_id: s.connectorId, model: s.model, family: s.family, role,
    persona: composePersona(s), temperature: s.temperature ?? 0.7,
  });
  return {
    domain,
    mode: cfg.mode,
    max_points: cfg.maxPoints,
    max_total_tokens: cfg.maxTotalTokens ?? null,
    research_enabled: cfg.researchEnabled,
    session_id: sessionId,
    connectors,
    role_map: {
      agent_a: seat(cfg.seats.agent_a, 'agentA'),
      agent_b: seat(cfg.seats.agent_b, 'agentB'),
      judge: seat(cfg.seats.judge, 'judge'),
      // >=2 panel debaters are passed through; the Python side runs the panel engine when >2.
      ...(cfg.seats.debaters && cfg.seats.debaters.length >= 2
        ? { debaters: cfg.seats.debaters.map((d, i) => seat(d, `agent${i}`)) }
        : {}),
    },
  };
}

/** run.executePlan params = a session params bundle plus the approved points + edges. */
export function buildExecuteParams(domain: string, cfg: BrainstormConfig, sessionId: string,
                                   allowRemote: boolean, points: unknown[], edges: unknown[]): Record<string, unknown> {
  return { ...buildSessionParams(domain, cfg, sessionId, allowRemote), points, edges };
}

/**
 * Combine a seat's typed persona text with an attached skill file into one system prompt.
 * Skill content stays prompt-level (no engine knobs) — it is appended under a clear header
 * so the model reads it as added behavioural directives. Typed text comes first.
 */
export function composePersona(s: SeatDef): string {
  const persona = (s.persona ?? '').trim();
  const content = s.skill?.content?.trim();
  if (!content) return persona;
  const block = formatSkill(s.skill!.name, s.skill!.content);
  return persona ? `${persona}\n\n${block}` : block;
}

/**
 * Render a skill file as readable directives: simple `key: value` YAML front-matter (if
 * present) becomes a bullet list, followed by the markdown body. Dependency-free — no YAML
 * parser, no engine wiring.
 */
export function formatSkill(name: string, content: string): string {
  const { front, body } = splitFrontMatter(content);
  const lines: string[] = [`## Loaded skill: ${name}`];
  if (front.length) {
    lines.push('Operating directives:');
    for (const [k, v] of front) lines.push(`- ${humanizeKey(k)}: ${v}`);
    lines.push('');
  }
  const trimmedBody = body.trim();
  if (trimmedBody) lines.push(trimmedBody);
  return lines.join('\n').trim();
}

function splitFrontMatter(content: string): { front: Array<[string, string]>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
  if (!m) return { front: [], body: content };
  const front: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (k) front.push([k, v]);
    }
  }
  return { front, body: content.slice(m[0].length) };
}

function humanizeKey(k: string): string {
  return k.replace(/[_-]+/g, ' ').trim();
}
