import * as vscode from 'vscode';
import { BrainstormConfig, ConnectorRegistry, defaultConfig } from './connectorRegistry';
import { SecretsStore } from './secrets';

/**
 * adminConsolePanel.ts (N19) — the secure multi-LLM configuration surface.
 *
 * A structured form (not raw JSON) to edit the connector catalog — including the
 * sandboxed **CLI** connector (command / prompt-mode / timeout fields shown only when
 * kind = cli) — the three debate seats, an optional **panel** of debaters (>=3 → the
 * N-way panel engine), and session settings (mode / points / budget / research). API
 * keys are set per-connector via ``showInputBox({ password: true })`` and go straight
 * to SecretStorage — never the webview, settings, or logs (S1/S7). The webview is
 * CSP-hardened and builds all rows with ``createElement`` (no innerHTML of config data).
 */
export class AdminConsolePanel {
  public static readonly viewType = 'brainstrom.adminConsole';
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ConnectorRegistry,
    private readonly secrets: SecretsStore,
  ) { }

  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel(
      AdminConsolePanel.viewType, 'BrainStrom: Configure', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.render();
  }

  private render(): void {
    if (this.panel) {
      this.panel.webview.html = this.html(this.registry.getConfig());
    }
  }

  private async onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'save') {
      const cfg = msg.config as BrainstormConfig | undefined;
      if (!cfg || !Array.isArray(cfg.connectors) || !cfg.seats) {
        vscode.window.showErrorMessage('BrainStrom: invalid configuration payload.');
        return;
      }
      await this.registry.setConfig(cfg);
      vscode.window.showInformationMessage('BrainStrom configuration saved.');
    } else if (msg.type === 'setKey') {
      const id = String(msg.connectorId || '').trim();
      if (!id) { vscode.window.showWarningMessage('Enter a connector id first.'); return; }
      const key = await vscode.window.showInputBox({
        prompt: `API key for connector "${id}" (stored in the OS keychain, never shown again)`,
        password: true, ignoreFocusOut: true,
      });
      if (key !== undefined) {
        await this.secrets.setKey(id, key);
        vscode.window.showInformationMessage(`API key stored for connector "${id}".`);
      }
    } else if (msg.type === 'reset') {
      await this.registry.setConfig(defaultConfig());
      this.render();
    }
  }

  private html(cfg: BrainstormConfig): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');   // safe to embed in <script>
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           font-size: var(--vscode-font-size); padding: 12px; }
    h2 { font-size: 1.2em; } h3 { font-size: 1.05em; margin: 16px 0 6px; }
    .hint { color: var(--vscode-descriptionForeground); margin: 4px 0; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0;
           padding: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    label { display: inline-flex; flex-direction: column; font-size: 0.85em;
            color: var(--vscode-descriptionForeground); }
    input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; }
    input.id, input.model, input.base { width: 150px; } input.fam { width: 110px; }
    input.persona { width: 200px; } input.num { width: 70px; }
    button { padding: 4px 10px; cursor: pointer; background: var(--vscode-button-background);
             color: var(--vscode-button-foreground); border: none; border-radius: 3px; }
    button.secondary { background: var(--vscode-button-secondaryBackground);
             color: var(--vscode-button-secondaryForeground); }
    .bar { margin-top: 16px; display: flex; gap: 8px; }
    .cli-only { display: none; gap: 6px; }
    .seat { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin: 6px 0; }
  </style>
</head>
<body>
  <h2>BrainStrom — Configure debate connectors &amp; seats</h2>
  <p class="hint">Connector kinds: <code>openai</code> / <code>anthropic</code> (remote APIs — need
    <code>brainstrom.allowRemote</code> + a key), <code>openai-compatible</code> (local, e.g. LM Studio),
    <code>cli</code> (drives a local <code>codex</code>/<code>claude</code> CLI via its own login). Keys are stored in the OS keychain.</p>

  <h3>Connectors</h3>
  <div id="connectors"></div>
  <button id="addConnector" class="secondary">+ Add connector</button>

  <h3>Seats</h3>
  <p class="hint">Each seat references a connector id. agent_a / agent_b are the two debaters; judge is the moderator/referee/scribe.</p>
  <div id="seats"></div>

  <h3>Panel debaters (optional)</h3>
  <p class="hint">Add <b>3 or more</b> here to debate each knowledge point as an N-way <b>panel</b>. Fewer than 3 falls back to agent_a / agent_b.</p>
  <div id="debaters"></div>
  <button id="addDebater" class="secondary">+ Add debater</button>

  <h3>Session</h3>
  <div class="row">
    <label>mode<select id="mode"></select></label>
    <label>max points<input id="maxPoints" class="num" type="number" min="2" max="20" /></label>
    <label>max total tokens<input id="maxTotalTokens" class="num" type="number" min="0" /></label>
    <label>research<input id="researchEnabled" type="checkbox" /></label>
  </div>

  <div class="bar">
    <button id="save">Save configuration</button>
    <button id="reset" class="secondary">Reset to defaults</button>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const CFG = ${cfgJson};
    const KINDS = ['openai', 'anthropic', 'openai-compatible', 'cli'];
    const MODES = ['mixed', 'critical', 'heuristic', 'game-theoretic'];

    function el(tag, attrs, kids) {
      const n = document.createElement(tag);
      for (const k in (attrs || {})) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'value') n.value = attrs[k];
        else if (k === 'checked') n.checked = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
      for (const c of (kids || [])) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      return n;
    }
    function field(labelText, input) { return el('label', {}, [labelText, input]); }
    function select(cls, options, value) {
      const s = el('select', { class: cls });
      for (const o of options) { const opt = el('option', { value: o }, [o]); if (o === value) opt.selected = true; s.appendChild(opt); }
      return s;
    }

    function connectorRow(c) {
      c = c || { id: '', kind: 'openai-compatible', baseUrl: '' };
      const kindSel = select('c-kind', KINDS, c.kind);
      const cli = el('span', { class: 'cli-only' }, [
        field('command', el('input', { class: 'c-command base', value: c.command || '', placeholder: 'e.g. claude -p' })),
        field('prompt', select('c-promptvia', ['stdin', 'arg'], c.promptVia || 'stdin')),
        field('timeout s', el('input', { class: 'c-timeout num', type: 'number', value: c.timeout || '' })),
      ]);
      const toggleCli = () => { cli.style.display = kindSel.value === 'cli' ? 'inline-flex' : 'none'; };
      kindSel.addEventListener('change', toggleCli);
      const row = el('div', { class: 'connector-row row' }, [
        field('id', el('input', { class: 'c-id id', value: c.id || '' })),
        field('kind', kindSel),
        field('base url', el('input', { class: 'c-baseurl base', value: c.baseUrl || '', placeholder: 'http://localhost:1234/v1' })),
        cli,
        el('button', { class: 'secondary c-setkey' }, ['Set API key…']),
        el('button', { class: 'secondary c-remove' }, ['Remove']),
      ]);
      row.querySelector('.c-setkey').addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'setKey', connectorId: row.querySelector('.c-id').value }));
      row.querySelector('.c-remove').addEventListener('click', () => row.remove());
      setTimeout(toggleCli, 0);
      return row;
    }

    function seatBlock(name, s) {
      s = s || { connectorId: '', model: '', family: '' };
      return el('div', { class: 'seat', id: 'seat-' + name }, [
        el('b', {}, [name]),
        el('div', { class: 'row' }, [
          field('connector id', el('input', { class: 's-conn id', value: s.connectorId || '' })),
          field('model', el('input', { class: 's-model model', value: s.model || '' })),
          field('family', el('input', { class: 's-family fam', value: s.family || '' })),
          field('persona', el('input', { class: 's-persona persona', value: s.persona || '' })),
          field('temp', el('input', { class: 's-temp num', type: 'number', step: '0.1', value: (s.temperature ?? '') })),
        ]),
      ]);
    }

    function debaterRow(d) {
      d = d || { connectorId: '', model: '', family: '' };
      const row = el('div', { class: 'debater-row row' }, [
        field('connector id', el('input', { class: 'd-conn id', value: d.connectorId || '' })),
        field('model', el('input', { class: 'd-model model', value: d.model || '' })),
        field('family', el('input', { class: 'd-family fam', value: d.family || '' })),
        el('button', { class: 'secondary d-remove' }, ['Remove']),
      ]);
      row.querySelector('.d-remove').addEventListener('click', () => row.remove());
      return row;
    }

    // ---- render from CFG ----
    const connectorsBox = document.getElementById('connectors');
    (CFG.connectors || []).forEach(c => connectorsBox.appendChild(connectorRow(c)));
    const seatsBox = document.getElementById('seats');
    seatsBox.appendChild(seatBlock('agent_a', CFG.seats && CFG.seats.agent_a));
    seatsBox.appendChild(seatBlock('agent_b', CFG.seats && CFG.seats.agent_b));
    seatsBox.appendChild(seatBlock('judge', CFG.seats && CFG.seats.judge));
    const debatersBox = document.getElementById('debaters');
    ((CFG.seats && CFG.seats.debaters) || []).forEach(d => debatersBox.appendChild(debaterRow(d)));
    const modeSel = document.getElementById('mode');
    MODES.forEach(m => { const o = el('option', { value: m }, [m]); if (m === CFG.mode) o.selected = true; modeSel.appendChild(o); });
    document.getElementById('maxPoints').value = CFG.maxPoints || 5;
    document.getElementById('maxTotalTokens').value = CFG.maxTotalTokens || '';
    document.getElementById('researchEnabled').checked = !!CFG.researchEnabled;

    document.getElementById('addConnector').addEventListener('click', () => connectorsBox.appendChild(connectorRow()));
    document.getElementById('addDebater').addEventListener('click', () => debatersBox.appendChild(debaterRow()));
    document.getElementById('reset').addEventListener('click', () => vscodeApi.postMessage({ type: 'reset' }));

    // ---- serialize on save ----
    function readConnectors() {
      return [...document.querySelectorAll('.connector-row')].map(row => {
        const kind = row.querySelector('.c-kind').value;
        const def = { id: row.querySelector('.c-id').value.trim(), kind, baseUrl: row.querySelector('.c-baseurl').value.trim() };
        if (kind === 'cli') {
          const cmd = row.querySelector('.c-command').value.trim();
          if (cmd) def.command = cmd;
          def.promptVia = row.querySelector('.c-promptvia').value;
          const t = parseInt(row.querySelector('.c-timeout').value, 10);
          if (t) def.timeout = t;
        }
        return def;
      }).filter(c => c.id);
    }
    function readSeat(name) {
      const root = document.getElementById('seat-' + name);
      const s = { connectorId: root.querySelector('.s-conn').value.trim(),
                  model: root.querySelector('.s-model').value.trim(),
                  family: root.querySelector('.s-family').value.trim() };
      const persona = root.querySelector('.s-persona').value.trim(); if (persona) s.persona = persona;
      const temp = parseFloat(root.querySelector('.s-temp').value); if (!isNaN(temp)) s.temperature = temp;
      return s;
    }
    function readDebaters() {
      return [...document.querySelectorAll('.debater-row')].map(row => ({
        connectorId: row.querySelector('.d-conn').value.trim(),
        model: row.querySelector('.d-model').value.trim(),
        family: row.querySelector('.d-family').value.trim(),
      })).filter(d => d.connectorId && d.model);
    }
    document.getElementById('save').addEventListener('click', () => {
      const seats = { agent_a: readSeat('agent_a'), agent_b: readSeat('agent_b'), judge: readSeat('judge') };
      const deb = readDebaters();
      if (deb.length >= 2) seats.debaters = deb;
      const cfg = {
        connectors: readConnectors(), seats,
        mode: document.getElementById('mode').value,
        maxPoints: parseInt(document.getElementById('maxPoints').value, 10) || 5,
        researchEnabled: document.getElementById('researchEnabled').checked,
      };
      const mt = parseInt(document.getElementById('maxTotalTokens').value, 10);
      if (mt) cfg.maxTotalTokens = mt;
      vscodeApi.postMessage({ type: 'save', config: cfg });
    });
  </script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
