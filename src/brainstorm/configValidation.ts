// configValidation.ts — schema validation for a BrainstormConfig at the extension-host
// boundary, BEFORE it is persisted (audit F8). Kept free of any `vscode` import so it is
// unit-testable under node:test.
//
// `validateConfigDetailed` returns structured { field, message } problems so the Configure
// webview can show each error INLINE next to the offending control. `validateConfig` is the
// original string[] view (= the messages), kept stable so existing callers/tests are
// unaffected. `field` is a dotted/bracketed path the webview maps to a DOM element, e.g.
// `connectors[2].baseUrl`, `seats.agent_a.connectorId`, `seats.debaters[0].model`, `maxPoints`.
// An empty `field` means a config-level problem with no single control.

const VALID_KINDS = new Set(['openai', 'anthropic', 'openai-compatible', 'cli']);
const VALID_MODES = new Set(['mixed', 'critical', 'heuristic', 'game-theoretic']);

export interface ConfigProblem {
  field: string;
  message: string;
}

export function validateConfigDetailed(cfg: any): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!cfg || typeof cfg !== 'object') {
    return [{ field: '', message: 'configuration is not an object' }];
  }
  const connectors = Array.isArray(cfg.connectors) ? cfg.connectors : [];
  if (connectors.length === 0) {
    add('connectors', 'at least one connector is required');
  }
  const ids = new Set<string>();
  connectors.forEach((c: any, idx: number) => {
    const id = typeof c?.id === 'string' ? c.id.trim() : '';
    if (!id) { add(`connectors[${idx}].id`, 'a connector has an empty id'); return; }
    if (ids.has(id)) { add(`connectors[${idx}].id`, `duplicate connector id "${id}"`); }
    ids.add(id);
    if (!VALID_KINDS.has(c.kind)) { add(`connectors[${idx}].kind`, `connector "${id}" has unknown kind "${c.kind}"`); }
    if (c.kind === 'cli') {
      const cmd = c.command;
      const hasCmd = (typeof cmd === 'string' && cmd.trim().length > 0) || (Array.isArray(cmd) && cmd.length > 0);
      if (!hasCmd) { add(`connectors[${idx}].command`, `cli connector "${id}" needs a command`); }
      if (c.promptVia !== undefined && c.promptVia !== 'stdin' && c.promptVia !== 'arg') {
        add(`connectors[${idx}].promptVia`, `connector "${id}" has invalid prompt mode "${c.promptVia}"`);
      }
      if (c.timeout !== undefined && (typeof c.timeout !== 'number' || c.timeout < 0)) {
        add(`connectors[${idx}].timeout`, `connector "${id}" has an invalid timeout`);
      }
    } else {
      const url = typeof c?.baseUrl === 'string' ? c.baseUrl.trim() : '';
      if (!url) { add(`connectors[${idx}].baseUrl`, `connector "${id}" needs a base url`); }
      else { try { new URL(url); } catch { add(`connectors[${idx}].baseUrl`, `connector "${id}" has an invalid base url "${url}"`); } }
    }
  });
  const seats = cfg.seats;
  if (!seats || typeof seats !== 'object') {
    add('seats', 'seats are required');
  } else {
    for (const role of ['agent_a', 'agent_b', 'judge']) {
      const s = (seats as any)[role];
      if (!s || typeof s !== 'object') { add(`seats.${role}`, `seat "${role}" is missing`); continue; }
      const cid = typeof s.connectorId === 'string' ? s.connectorId.trim() : '';
      if (!cid) { add(`seats.${role}.connectorId`, `seat "${role}" has no connector id`); }
      else if (ids.size > 0 && !ids.has(cid)) { add(`seats.${role}.connectorId`, `seat "${role}" references unknown connector "${cid}"`); }
      if (typeof s.model !== 'string' || !s.model.trim()) { add(`seats.${role}.model`, `seat "${role}" has no model`); }
    }
    if ((seats as any).debaters !== undefined) {
      const debaters = (seats as any).debaters;
      if (!Array.isArray(debaters)) { add('seats.debaters', 'debaters must be a list'); }
      else {
        debaters.forEach((d: any, i: number) => {
          const cid = typeof d?.connectorId === 'string' ? d.connectorId.trim() : '';
          if (!cid) { add(`seats.debaters[${i}].connectorId`, `debater #${i + 1} has no connector id`); }
          else if (ids.size > 0 && !ids.has(cid)) { add(`seats.debaters[${i}].connectorId`, `debater #${i + 1} references unknown connector "${cid}"`); }
          if (typeof d?.model !== 'string' || !d.model.trim()) { add(`seats.debaters[${i}].model`, `debater #${i + 1} has no model`); }
        });
      }
    }
  }
  if (cfg.mode !== undefined && !VALID_MODES.has(cfg.mode)) { add('mode', `unknown debate mode "${cfg.mode}"`); }
  if (cfg.maxPoints !== undefined && (typeof cfg.maxPoints !== 'number' || cfg.maxPoints < 2 || cfg.maxPoints > 20)) {
    add('maxPoints', 'max points must be a number between 2 and 20');
  }
  if (cfg.maxTotalTokens !== undefined && cfg.maxTotalTokens !== null &&
      (typeof cfg.maxTotalTokens !== 'number' || cfg.maxTotalTokens < 0)) {
    add('maxTotalTokens', 'max total tokens must be a non-negative number');
  }
  return problems;
}

/** Original string[] view (= the problem messages). Stable for existing callers/tests. */
export function validateConfig(cfg: any): string[] {
  return validateConfigDetailed(cfg).map(p => p.message);
}
