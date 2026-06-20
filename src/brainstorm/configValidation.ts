// configValidation.ts — schema validation for a BrainstormConfig at the extension-host
// boundary, BEFORE it is persisted (audit F8). Kept free of any `vscode` import so it is
// unit-testable under node:test. Returns a list of human-readable problems ([] = valid).

const VALID_KINDS = new Set(['openai', 'anthropic', 'openai-compatible', 'cli']);
const VALID_MODES = new Set(['mixed', 'critical', 'heuristic', 'game-theoretic']);

export function validateConfig(cfg: any): string[] {
  const problems: string[] = [];
  if (!cfg || typeof cfg !== 'object') {
    return ['configuration is not an object'];
  }
  const connectors = Array.isArray(cfg.connectors) ? cfg.connectors : [];
  if (connectors.length === 0) {
    problems.push('at least one connector is required');
  }
  const ids = new Set<string>();
  for (const c of connectors) {
    const id = typeof c?.id === 'string' ? c.id.trim() : '';
    if (!id) { problems.push('a connector has an empty id'); continue; }
    if (ids.has(id)) { problems.push(`duplicate connector id "${id}"`); }
    ids.add(id);
    if (!VALID_KINDS.has(c.kind)) { problems.push(`connector "${id}" has unknown kind "${c.kind}"`); }
    if (c.kind === 'cli') {
      const cmd = c.command;
      const hasCmd = (typeof cmd === 'string' && cmd.trim().length > 0) || (Array.isArray(cmd) && cmd.length > 0);
      if (!hasCmd) { problems.push(`cli connector "${id}" needs a command`); }
      if (c.promptVia !== undefined && c.promptVia !== 'stdin' && c.promptVia !== 'arg') {
        problems.push(`connector "${id}" has invalid prompt mode "${c.promptVia}"`);
      }
      if (c.timeout !== undefined && (typeof c.timeout !== 'number' || c.timeout < 0)) {
        problems.push(`connector "${id}" has an invalid timeout`);
      }
    } else {
      const url = typeof c?.baseUrl === 'string' ? c.baseUrl.trim() : '';
      if (!url) { problems.push(`connector "${id}" needs a base url`); }
      else { try { new URL(url); } catch { problems.push(`connector "${id}" has an invalid base url "${url}"`); } }
    }
  }
  const seats = cfg.seats;
  if (!seats || typeof seats !== 'object') {
    problems.push('seats are required');
  } else {
    for (const role of ['agent_a', 'agent_b', 'judge']) {
      const s = (seats as any)[role];
      if (!s || typeof s !== 'object') { problems.push(`seat "${role}" is missing`); continue; }
      const cid = typeof s.connectorId === 'string' ? s.connectorId.trim() : '';
      if (!cid) { problems.push(`seat "${role}" has no connector id`); }
      else if (ids.size > 0 && !ids.has(cid)) { problems.push(`seat "${role}" references unknown connector "${cid}"`); }
      if (typeof s.model !== 'string' || !s.model.trim()) { problems.push(`seat "${role}" has no model`); }
    }
    if ((seats as any).debaters !== undefined) {
      const debaters = (seats as any).debaters;
      if (!Array.isArray(debaters)) { problems.push('debaters must be a list'); }
      else {
        debaters.forEach((d: any, i: number) => {
          const cid = typeof d?.connectorId === 'string' ? d.connectorId.trim() : '';
          if (!cid) { problems.push(`debater #${i + 1} has no connector id`); }
          else if (ids.size > 0 && !ids.has(cid)) { problems.push(`debater #${i + 1} references unknown connector "${cid}"`); }
          if (typeof d?.model !== 'string' || !d.model.trim()) { problems.push(`debater #${i + 1} has no model`); }
        });
      }
    }
  }
  if (cfg.mode !== undefined && !VALID_MODES.has(cfg.mode)) { problems.push(`unknown debate mode "${cfg.mode}"`); }
  if (cfg.maxPoints !== undefined && (typeof cfg.maxPoints !== 'number' || cfg.maxPoints < 2 || cfg.maxPoints > 20)) {
    problems.push('max points must be a number between 2 and 20');
  }
  if (cfg.maxTotalTokens !== undefined && cfg.maxTotalTokens !== null &&
      (typeof cfg.maxTotalTokens !== 'number' || cfg.maxTotalTokens < 0)) {
    problems.push('max total tokens must be a non-negative number');
  }
  return problems;
}
