import * as vscode from 'vscode';
import { BrainstormConfig, ConnectorRegistry, defaultConfig } from './connectorRegistry';
import { validateConfig } from './configValidation';
import { SecretsStore } from './secrets';

/** A VS Code setting surfaced (and made switchable) inside the configure panel, so every
 *  adjustable option lives in one place. `type: 'bool'` renders as an on/off switch. */
interface SettingSpec {
  key: string;
  type: 'bool' | 'string' | 'number' | 'enum';
  label: string;
  help: string;
  group: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

/** Every adjustable VS Code setting in the software, centralized into the configure panel. */
const SETTINGS_SPEC: SettingSpec[] = [
  { key: 'brainstrom.allowRemote', type: 'bool', group: 'BrainStrom', label: 'Allow remote endpoints',
    help: 'Allow BrainStrom to reach non-local model endpoints (OpenAI / Anthropic). Off by default; remote still needs an allowlisted host + https.' },
  { key: 'brainstrom.autoConfirmPlan', type: 'bool', group: 'BrainStrom', label: 'Auto-run (skip plan approval)',
    help: 'On: decompose and debate in one turn. Off (default): BrainStrom proposes the plan first and waits for you to reply "go" (CONFIRM_PLAN).' },
  { key: 'lmstudio.baseUrl', type: 'string', group: 'Local model chat', label: 'LM Studio base URL', placeholder: 'http://localhost:1234',
    help: 'Base URL of your LM Studio server for the ModelLane chat + code actions.' },
  { key: 'lmstudio.apiMode', type: 'enum', group: 'Local model chat', label: 'API mode', options: ['native', 'openai'],
    help: 'native = LM Studio /api/v1 endpoints; openai = OpenAI-compatible /v1 endpoints.' },
  { key: 'lmstudio.allowRemoteBaseUrl', type: 'bool', group: 'Local model chat', label: 'Allow remote LM Studio host',
    help: 'Allow sending prompts / code to a non-local LM Studio host. Off by default.' },
  { key: 'lmstudio.model', type: 'string', group: 'Local model chat', label: 'Default model', placeholder: 'auto-detect',
    help: 'Model id for the ModelLane chat (blank = auto-detect).' },
  { key: 'lmstudio.maxTokens', type: 'number', group: 'Local model chat', label: 'Max tokens', min: 128, max: 32768,
    help: 'Maximum tokens per ModelLane chat response (128-32768).' },
  { key: 'lmstudio.temperature', type: 'number', group: 'Local model chat', label: 'Temperature', min: 0, max: 2, step: 0.1,
    help: 'Sampling temperature for the ModelLane chat (0-2).' },
  { key: 'lmstudio.agent.maxIterations', type: 'number', group: 'Local model chat', label: 'Agent max iterations', min: 1, max: 20,
    help: 'Max tool-use steps the chat Agent mode may take for one request (1-20).' },
  { key: 'lmstudio.enableInlineCompletion', type: 'bool', group: 'Local model chat', label: 'Inline completion',
    help: 'Enable inline code completion (sends nearby code to the configured API). Off by default.' },
  { key: 'lmstudio.enableContextMenu', type: 'bool', group: 'Local model chat', label: 'Editor context menu',
    help: 'Show the ModelLane right-click code actions (explain / refactor / review / generate tests).' },
  { key: 'localModels.ollamaBaseUrl', type: 'string', group: 'Local endpoints', label: 'Ollama URL', placeholder: 'http://localhost:11434',
    help: 'Ollama base URL used by VS Code’s built-in chat model picker.' },
  { key: 'localModels.vllmBaseUrl', type: 'string', group: 'Local endpoints', label: 'vLLM URL', placeholder: 'http://localhost:8000',
    help: 'vLLM OpenAI-compatible base URL.' },
  { key: 'localModels.llamaCppBaseUrl', type: 'string', group: 'Local endpoints', label: 'llama.cpp URL', placeholder: 'http://localhost:8080',
    help: 'llama.cpp OpenAI-compatible base URL.' },
  { key: 'localModels.llamafileBaseUrl', type: 'string', group: 'Local endpoints', label: 'Llamafile URL', placeholder: 'http://localhost:8080',
    help: 'Llamafile OpenAI-compatible base URL.' },
];

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
      // Full schema validation before persisting (audit F8): reject unknown connector
      // kinds, empty ids, invalid URLs/prompt modes, negative limits, missing seats.
      const problems = validateConfig(cfg);
      if (problems.length > 0) {
        vscode.window.showErrorMessage('BrainStrom: configuration not saved — ' + problems.slice(0, 6).join('; '));
        return;
      }
      await this.registry.setConfig(cfg);
      await this.applySettings(msg.settings);
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
    } else if (msg.type === 'pickSkillFile') {
      await this.pickSkillFile(msg);
    } else if (msg.type === 'reset') {
      await this.registry.setConfig(defaultConfig());
      this.render();
    }
  }

  /** Open a file dialog, read a skill file, and post its content back to the webview
   *  (mirrors the setKey round-trip). Skill files are markdown/text, never secrets. */
  private async pickSkillFile(msg: any): Promise<void> {
    const scope = String(msg.scope || '');
    const key = msg.key;
    if (!scope || key === undefined || key === null) return;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Load skill',
      filters: { 'Skill files': ['md', 'markdown', 'txt'], 'All files': ['*'] },
    });
    if (!picked || picked.length === 0) return;
    const uri = picked[0];
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      vscode.window.showErrorMessage('BrainStrom: could not read that skill file.');
      return;
    }
    const MAX_BYTES = 64 * 1024;
    if (bytes.byteLength > MAX_BYTES) {
      vscode.window.showWarningMessage(
        `BrainStrom: skill file is too large (${Math.round(bytes.byteLength / 1024)} KB; max 64 KB).`);
      return;
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    const name = uri.path.split('/').pop() || 'skill';
    this.panel?.webview.postMessage({ type: 'skillFileLoaded', scope, key, name, content });
  }

  /** Current values of all centralized VS Code settings (injected into the webview). */
  private gatherSettings(): Record<string, unknown> {
    const cfg = vscode.workspace.getConfiguration();
    const out: Record<string, unknown> = {};
    for (const s of SETTINGS_SPEC) out[s.key] = cfg.get(s.key);
    return out;
  }

  /** Write the CHANGED settings from the panel to VS Code user settings. */
  private async applySettings(settings: any): Promise<void> {
    if (!settings || typeof settings !== 'object') return;
    const cfg = vscode.workspace.getConfiguration();
    const failed: string[] = [];
    for (const s of SETTINGS_SPEC) {
      if (!(s.key in settings)) continue;
      let v: unknown = settings[s.key];
      if (s.type === 'bool') v = !!v;
      else if (s.type === 'number') {
        const n = Number(v);
        v = (v === '' || v === null || v === undefined || Number.isNaN(n)) ? undefined : n;
      }
      if (JSON.stringify(cfg.get(s.key)) === JSON.stringify(v)) continue;   // only write real changes
      try {
        await cfg.update(s.key, v, vscode.ConfigurationTarget.Global);
      } catch {
        failed.push(s.key);
      }
    }
    if (failed.length) {
      vscode.window.showWarningMessage('BrainStrom: could not save some settings: ' + failed.join(', '));
    }
  }

  private html(cfg: BrainstormConfig): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');   // safe to embed in <script>
    const settingsSpecJson = JSON.stringify(SETTINGS_SPEC).replace(/</g, '\\u003c');
    const settingsValsJson = JSON.stringify(this.gatherSettings()).replace(/</g, '\\u003c');
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
    .fieldcol { display: inline-flex; flex-direction: column; }
    .lbl { display: inline-flex; align-items: center; gap: 2px; font-size: 0.85em;
           color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
    .help { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px;
            border-radius: 50%; border: 1px solid var(--vscode-descriptionForeground); background: transparent;
            color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1; cursor: pointer; user-select: none; }
    .help:hover { color: var(--vscode-foreground); border-color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .combo { display: inline-flex; align-items: center; gap: 4px; }
    .combo-select, .combo-input { width: 150px; }
    .combo-back { padding: 2px 6px; min-width: 22px; }
    .persona-row { display: inline-flex; align-items: center; gap: 4px; }
    #help-pop { position: absolute; display: none; max-width: 340px; padding: 8px 10px; z-index: 50;
            background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
            color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
            border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.35); font-size: 0.85em; }
    #help-pop h4 { margin: 0 0 4px; font-size: 1em; }
    #help-pop div { white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
    .chip-box { display: inline-flex; align-items: center; }
    .chip { display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; padding: 1px 8px;
            border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8em; }
    .chip .x { cursor: pointer; font-weight: bold; opacity: 0.8; }
    .chip .x:hover { opacity: 1; }
    .switch { position: relative; display: inline-block; width: 34px; height: 18px; }
    .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
    .switch .slider { position: absolute; inset: 0; cursor: pointer; border-radius: 18px;
            background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); transition: background .15s; }
    .switch .slider::before { content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px;
            border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform .15s, background .15s; }
    .switch input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    .switch input:checked + .slider::before { transform: translateX(16px); background: var(--vscode-button-foreground); }
    .switch input:focus-visible + .slider { outline: 1px solid var(--vscode-focusBorder); }
    .set-input { width: 170px; } select.set-input { width: 178px; }
  </style>
</head>
<body>
  <h2>BrainStrom — Configure debate connectors &amp; seats</h2>
  <p class="hint">Connector kinds: <code>openai</code> / <code>anthropic</code> (remote APIs — need
    <code>brainstrom.allowRemote</code> + a key), <code>openai-compatible</code> (local, e.g. LM Studio),
    <code>cli</code> (drives a local <code>codex</code>/<code>claude</code> CLI via its own login). Keys are stored in the OS keychain.</p>

  <h3>Connectors <span class="help" data-help="connectors">?</span></h3>
  <div id="connectors"></div>
  <button id="addConnector" class="secondary">+ Add connector</button>

  <h3>Seats <span class="help" data-help="seats">?</span></h3>
  <p class="hint">Each seat references a connector id. agent_a / agent_b are the two debaters; judge is the moderator/referee/scribe.</p>
  <div id="seats"></div>

  <h3>Panel debaters (optional) <span class="help" data-help="debaters">?</span></h3>
  <p class="hint">Add <b>3 or more</b> here to debate each knowledge point as an N-way <b>panel</b>. Fewer than 3 falls back to agent_a / agent_b.</p>
  <div id="debaters"></div>
  <button id="addDebater" class="secondary">+ Add debater</button>

  <h3>Session <span class="help" data-help="session">?</span></h3>
  <div class="row">
    <span class="fieldcol"><span class="lbl">mode <span class="help" data-help="mode">?</span></span><select id="mode"></select></span>
    <span class="fieldcol"><span class="lbl">max points <span class="help" data-help="maxPoints">?</span></span><input id="maxPoints" class="num" type="number" min="2" max="20" /></span>
    <span class="fieldcol"><span class="lbl">max total tokens <span class="help" data-help="maxTotalTokens">?</span></span><input id="maxTotalTokens" class="num" type="number" min="0" /></span>
    <span class="fieldcol"><span class="lbl">research <span class="help" data-help="research">?</span></span><label class="switch"><input id="researchEnabled" type="checkbox" /><span class="slider"></span></label></span>
  </div>

  <h3>Global settings <span class="help" data-help="settingsSection">?</span></h3>
  <p class="hint">All ModelLane &amp; BrainStrom options in one place — saved to your VS Code user settings on <b>Save</b>. Boolean options are on/off switches.</p>
  <div id="settings"></div>

  <div class="bar">
    <button id="save">Save configuration</button>
    <button id="reset" class="secondary">Reset to defaults</button>
  </div>

  <div id="help-pop"></div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const CFG = ${cfgJson};
    const SETTINGS_SPEC = ${settingsSpecJson};
    const SETTINGS_VALUES = ${settingsValsJson};
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
    function helpSpan(key) {
      return key ? el('span', { class: 'help', 'data-help': key, title: 'What is this?' }, ['?']) : document.createTextNode('');
    }
    function field(labelText, input, helpKey) {
      return el('span', { class: 'fieldcol' }, [el('span', { class: 'lbl' }, [labelText, helpSpan(helpKey)]), input]);
    }

    // ---- on/off switch + a generic setting field (bool=switch, enum=select, else input) ----
    function switchControl(checked, cls, id, dataKey) {
      const input = el('input', { type: 'checkbox' });
      input.className = 'sw-input' + (cls ? ' ' + cls : '');
      if (id) input.id = id;
      if (dataKey) input.setAttribute('data-setkey', dataKey);
      input.checked = !!checked;
      return el('label', { class: 'switch' }, [input, el('span', { class: 'slider' }, [])]);
    }
    function switchField(labelText, helpKey, checked, dataKey) {
      return el('span', { class: 'fieldcol' }, [
        el('span', { class: 'lbl' }, [labelText, helpSpan(helpKey)]),
        switchControl(checked, '', '', dataKey),
      ]);
    }
    function settingField(s) {
      const val = SETTINGS_VALUES[s.key];
      const hk = 'set:' + s.key;
      if (s.type === 'bool') return switchField(s.label, hk, !!val, s.key);
      let control;
      if (s.type === 'enum') {
        control = select('set-input', s.options || [], val != null ? String(val) : (s.options || [''])[0]);
      } else {
        control = el('input', { class: 'set-input', type: s.type === 'number' ? 'number' : 'text',
          value: (val == null ? '' : String(val)), placeholder: s.placeholder || '' });
        if (s.min != null) control.setAttribute('min', String(s.min));
        if (s.max != null) control.setAttribute('max', String(s.max));
        if (s.step != null) control.setAttribute('step', String(s.step));
      }
      control.setAttribute('data-setkey', s.key);
      return field(s.label, control, hk);
    }
    function readSettings() {
      const out = {};
      for (const s of SETTINGS_SPEC) {
        const elx = document.querySelector('[data-setkey="' + s.key + '"]');
        if (!elx) continue;
        if (s.type === 'bool') out[s.key] = !!elx.checked;
        else if (s.type === 'number') { const n = parseFloat(elx.value); out[s.key] = isNaN(n) ? '' : n; }
        else out[s.key] = elx.value;
      }
      return out;
    }

    // ---- combo field: a dropdown of common values + an 'Other…' escape to free text ----
    const MODEL_PRESETS = ['local-model', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'];
    const FAMILY_PRESETS = ['debater-a', 'debater-b', 'moderator', 'harvester', 'unknown'];
    function currentConnectorIds() {
      const ids = [...document.querySelectorAll('.connector-row .c-id')].map(i => i.value.trim()).filter(Boolean);
      const uniq = [...new Set(ids)];
      return uniq.length ? uniq : ['local'];
    }
    function comboControl(cls, value, presetsOrFn) {
      value = value || '';
      const wrap = el('span', { class: 'combo' }, []);
      const holder = el('input', { class: cls, type: 'hidden', value: value });
      wrap.appendChild(holder);
      const setVal = (v) => { holder.value = v; };
      const presets = () => (typeof presetsOrFn === 'function' ? presetsOrFn() : presetsOrFn) || [];
      const clearUi = () => { [...wrap.querySelectorAll('.combo-ui')].forEach(n => n.remove()); };
      function populate(sel, selected) {
        sel.replaceChildren();
        const list = presets();
        for (const p of list) sel.appendChild(el('option', { value: p }, [p]));
        if (selected && list.indexOf(selected) < 0) sel.appendChild(el('option', { value: selected }, [selected]));
        sel.appendChild(el('option', { value: '__other__' }, ['Other…']));
        sel.value = selected ? selected : (list[0] || '');
      }
      function showSelect(selected) {
        clearUi();
        const sel = el('select', { class: 'combo-ui combo-select' });
        populate(sel, selected);
        setVal(sel.value === '__other__' ? '' : sel.value);
        sel.addEventListener('focus', () => populate(sel, holder.value || undefined));
        sel.addEventListener('change', () => { if (sel.value === '__other__') showInput(''); else setVal(sel.value); });
        wrap.appendChild(sel);
      }
      function showInput(v) {
        clearUi();
        const inp = el('input', { class: 'combo-ui combo-input', value: v || '', placeholder: 'custom value' });
        setVal(inp.value);
        inp.addEventListener('input', () => setVal(inp.value));
        const back = el('button', { class: 'combo-ui combo-back secondary', type: 'button', title: 'Choose from the list' }, ['\\u25BE']);
        back.addEventListener('click', () => showSelect(holder.value || undefined));
        wrap.appendChild(inp);
        wrap.appendChild(back);
        inp.focus();
      }
      if (value && presets().indexOf(value) < 0) showInput(value);
      else showSelect(value);
      return wrap;
    }
    function comboField(labelText, helpKey, cls, value, presetsOrFn) {
      return el('span', { class: 'fieldcol' }, [
        el('span', { class: 'lbl' }, [labelText, helpSpan(helpKey)]),
        comboControl(cls, value, presetsOrFn),
      ]);
    }
    function select(cls, options, value) {
      const s = el('select', { class: cls });
      for (const o of options) { const opt = el('option', { value: o }, [o]); if (o === value) opt.selected = true; s.appendChild(opt); }
      return s;
    }

    // ---- per-field floating help ('?' toggles) ----
    const HELP = {
      connectors: { t: 'Connectors', b: 'Define each model endpoint once, then reference it by id in the seats below.\\n\\nKinds: openai / anthropic (remote APIs — need brainstrom.allowRemote + a key), openai-compatible (a local OpenAI-style server such as LM Studio / Ollama / vLLM), cli (a local codex / claude CLI run as a sandboxed subprocess via its own login).' },
      'c-id': { t: 'Connector id', b: 'A short, unique name for this connector (e.g. local, openai).\\nSeats reference it by this exact id. Required.' },
      'c-kind': { t: 'Connector kind', b: 'openai / anthropic = remote cloud APIs.\\nopenai-compatible = a local OpenAI-style server (LM Studio, Ollama, vLLM, llama.cpp).\\ncli = drive a local codex / claude CLI (uses the CLI\\u2019s own login; no API key needed).' },
      'c-baseurl': { t: 'Base URL', b: 'The endpoint URL.\\nLocal example: http://localhost:1234/v1\\nRemote APIs must use https and require brainstrom.allowRemote + an allowlisted host.' },
      'c-command': { t: 'CLI command', b: '(cli only) The CLI in print / non-interactive mode, e.g. claude -p or codex exec.\\nRun with shell:false; the prompt is delivered via stdin or as an argument.' },
      'c-promptvia': { t: 'Prompt via', b: '(cli only) How the prompt reaches the CLI:\\nstdin = piped to standard input.\\narg = appended as an argument (or replaces {prompt} in the command).' },
      'c-timeout': { t: 'CLI timeout', b: '(cli only) Maximum seconds to wait for one CLI call before it fails. Default 120.' },
      seats: { t: 'Seats', b: 'The three debate roles mapped onto the engine:\\nagent_a / agent_b = the two debaters.\\njudge = moderator / referee / chief-scribe.\\nEach seat = a connector + model + persona.' },
      conn: { t: 'Connector id', b: 'Pick a connector defined above (e.g. local), or choose Other… to type a custom id.\\nMust match a connector id exactly. Required.' },
      model: { t: 'Model', b: 'Pick a common model, or choose Other… to type any model name your connector serves (e.g. local-model, gpt-4o, claude-3-5-sonnet).' },
      family: { t: 'Model family', b: 'A short label for the model family (e.g. debater-a, moderator). Pick one or choose Other… for a custom value.\\nUsed to down-weight agreement between same-family models and to verify with a different family.' },
      persona: { t: 'Persona', b: 'This seat\\u2019s role and instructions — sent to the model as its system prompt.\\n\\nType a short description, OR double-click the box to load a Markdown skill file (retrieval preferences, reasoning style, cognitive frameworks). Typed text and the skill file are combined.' },
      temp: { t: 'Temperature', b: 'Sampling temperature 0–2 (blank = 0.7).\\nLower = focused / deterministic (good for a critic or judge); higher = exploratory / diverse (good for ideation).' },
      debaters: { t: 'Panel debaters', b: 'Optional. Add 3 or more debaters to run each knowledge point as an N-way panel.\\nFewer than 3 falls back to agent_a / agent_b.\\nEach debater also takes a persona / skill file.' },
      skill: { t: 'Skill files', b: 'A skill file is a Markdown (.md / .txt) file describing how this persona should think and search — e.g. prefer academic databases, reason from first principles, use analogical or reverse thinking, a specific mathematical method.\\n\\nOptional simple key: value front-matter at the top is rendered as directives, followed by the body.\\nDouble-click the persona box to load one. Stored in the extension config (not the keychain) — do not put secrets in a skill file.' },
      session: { t: 'Session', b: 'Global run settings: the debate mode, how many knowledge points to extract, an optional hard token budget, and whether external web research is allowed.' },
      mode: { t: 'Debate mode', b: 'mixed (default) routes per point type.\\ncritical = flaws & assumptions.\\nheuristic = broad idea space.\\ngame-theoretic = incentives / strategy, high rigor.' },
      maxPoints: { t: 'Max points', b: 'How many debatable knowledge points to decompose the topic into (2–20). More points = deeper coverage but more tokens.' },
      maxTotalTokens: { t: 'Max total tokens', b: 'Optional hard cap on total estimated tokens for the whole session. Blank = no cap. The run stops if the cap is reached.' },
      research: { t: 'Research', b: 'Allow debaters to fetch external sources (Wikipedia / Semantic Scholar / etc.) during the debate.\\nOff by default for privacy — your topic is sent to those services when enabled.' },
      'c-filetools': { t: 'CLI file tools', b: '(cli only) Allow the CLI to use its file-writing tools. Off by default — the CLI runs single-shot in a bounded temp dir.' },
      settingsSection: { t: 'Global settings', b: 'Every adjustable ModelLane & BrainStrom option in one place. Changes are written to your VS Code user settings when you Save. Boolean options are on/off switches.' },
    };
    for (const s of SETTINGS_SPEC) HELP['set:' + s.key] = { t: s.label, b: s.help };
    const helpPop = document.getElementById('help-pop');
    let helpOpen = null;
    function showHelp(key, anchor) {
      const h = HELP[key]; if (!h) return;
      helpPop.replaceChildren();
      helpPop.appendChild(el('h4', {}, [h.t]));
      helpPop.appendChild(el('div', {}, [h.b]));
      const r = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 356));
      helpPop.style.left = (window.scrollX + left) + 'px';
      helpPop.style.top = (window.scrollY + r.bottom + 4) + 'px';
      helpPop.style.display = 'block';
      helpOpen = key;
    }
    function hideHelp() { helpPop.style.display = 'none'; helpOpen = null; }
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('help')) {
        const key = t.getAttribute('data-help');
        if (helpOpen === key) hideHelp(); else showHelp(key, t);
        e.stopPropagation();
        return;
      }
      if (helpOpen !== null && !helpPop.contains(t)) hideHelp();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHelp(); });

    function connectorRow(c) {
      c = c || { id: '', kind: 'openai-compatible', baseUrl: '' };
      const kindSel = select('c-kind', KINDS, c.kind);
      const cli = el('span', { class: 'cli-only' }, [
        field('command', el('input', { class: 'c-command base', value: c.command || '', placeholder: 'e.g. claude -p' }), 'c-command'),
        field('prompt', select('c-promptvia', ['stdin', 'arg'], c.promptVia || 'stdin'), 'c-promptvia'),
        field('timeout s', el('input', { class: 'c-timeout num', type: 'number', value: c.timeout || '' }), 'c-timeout'),
        el('span', { class: 'fieldcol' }, [el('span', { class: 'lbl' }, ['file tools', helpSpan('c-filetools')]), switchControl(c.allowFileTools, 'c-filetools')]),
      ]);
      const toggleCli = () => { cli.style.display = kindSel.value === 'cli' ? 'inline-flex' : 'none'; };
      kindSel.addEventListener('change', toggleCli);
      const row = el('div', { class: 'connector-row row' }, [
        field('id', el('input', { class: 'c-id id', value: c.id || '' }), 'c-id'),
        field('kind', kindSel, 'c-kind'),
        field('base url', el('input', { class: 'c-baseurl base', value: c.baseUrl || '', placeholder: 'http://localhost:1234/v1' }), 'c-baseurl'),
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

    // ---- persona + skill-file chips ----
    const SKILLS = new Map();   // targetId -> { name, content }
    const CHIPS = new Map();    // targetId -> chip container element
    let DEB_UID = 0;

    function splitTarget(targetId) {
      const i = targetId.indexOf(':');
      return [targetId.slice(0, i), targetId.slice(i + 1)];
    }
    function renderChip(targetId) {
      const box = CHIPS.get(targetId);
      if (!box) return;
      box.replaceChildren();
      const sk = SKILLS.get(targetId);
      if (!sk) return;
      const chip = el('span', { class: 'chip' }, []);
      chip.appendChild(el('span', { title: 'Loaded skill file' }, ['\\uD83D\\uDCCE ' + sk.name]));
      const x = el('span', { class: 'x', title: 'Remove skill' }, ['\\u2715']);
      x.addEventListener('click', () => { SKILLS.delete(targetId); renderChip(targetId); });
      chip.appendChild(x);
      box.appendChild(chip);
    }
    function personaField(targetId, personaValue, skill, cls) {
      const input = el('input', { class: cls + ' persona', value: personaValue || '',
        placeholder: 'short role text — double-click to load a skill file', title: 'Double-click to load a skill file' });
      input.addEventListener('dblclick', () => {
        const parts = splitTarget(targetId);
        vscodeApi.postMessage({ type: 'pickSkillFile', scope: parts[0], key: parts[1] });
      });
      const chipBox = el('span', { class: 'chip-box' }, []);
      CHIPS.set(targetId, chipBox);
      if (skill && skill.name) SKILLS.set(targetId, { name: String(skill.name), content: String(skill.content || '') });
      renderChip(targetId);
      return el('span', { class: 'fieldcol' }, [
        el('span', { class: 'lbl' }, ['persona', helpSpan('persona')]),
        el('span', { class: 'persona-row' }, [input, chipBox]),
      ]);
    }

    function seatBlock(name, s) {
      s = s || { connectorId: '', model: '', family: '' };
      return el('div', { class: 'seat', id: 'seat-' + name }, [
        el('b', {}, [name]),
        el('div', { class: 'row' }, [
          comboField('connector id', 'conn', 's-conn', s.connectorId, currentConnectorIds),
          comboField('model', 'model', 's-model', s.model, MODEL_PRESETS),
          comboField('family', 'family', 's-family', s.family, FAMILY_PRESETS),
          personaField('seat:' + name, s.persona, s.skill, 's-persona'),
          field('temp', el('input', { class: 's-temp num', type: 'number', step: '0.1', value: (s.temperature ?? '') }), 'temp'),
        ]),
      ]);
    }

    function debaterRow(d) {
      d = d || { connectorId: '', model: '', family: '' };
      const uid = ++DEB_UID;
      const targetId = 'deb:' + uid;
      const row = el('div', { class: 'debater-row row', 'data-uid': String(uid) }, [
        comboField('connector id', 'conn', 'd-conn', d.connectorId, currentConnectorIds),
        comboField('model', 'model', 'd-model', d.model, MODEL_PRESETS),
        comboField('family', 'family', 'd-family', d.family, FAMILY_PRESETS),
        personaField(targetId, d.persona, d.skill, 'd-persona'),
        field('temp', el('input', { class: 'd-temp num', type: 'number', step: '0.1', value: (d.temperature ?? '') }), 'temp'),
        el('button', { class: 'secondary d-remove' }, ['Remove']),
      ]);
      row.querySelector('.d-remove').addEventListener('click', () => { SKILLS.delete(targetId); CHIPS.delete(targetId); row.remove(); });
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

    // ---- render the centralized Global settings (grouped) ----
    (function renderSettings() {
      const box = document.getElementById('settings');
      const order = [];
      const groups = {};
      for (const s of SETTINGS_SPEC) { if (!groups[s.group]) { groups[s.group] = []; order.push(s.group); } groups[s.group].push(s); }
      for (const g of order) {
        const row = el('div', { class: 'row' }, []);
        for (const s of groups[g]) row.appendChild(settingField(s));
        box.appendChild(el('div', { class: 'seat' }, [el('b', {}, [g]), row]));
      }
    })();

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
          def.allowFileTools = row.querySelector('.c-filetools').checked;
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
      const skill = SKILLS.get('seat:' + name); if (skill) s.skill = skill;
      return s;
    }
    function readDebaters() {
      return [...document.querySelectorAll('.debater-row')].map(row => {
        const d = {
          connectorId: row.querySelector('.d-conn').value.trim(),
          model: row.querySelector('.d-model').value.trim(),
          family: row.querySelector('.d-family').value.trim(),
        };
        const persona = row.querySelector('.d-persona').value.trim(); if (persona) d.persona = persona;
        const temp = parseFloat(row.querySelector('.d-temp').value); if (!isNaN(temp)) d.temperature = temp;
        const skill = SKILLS.get('deb:' + row.getAttribute('data-uid')); if (skill) d.skill = skill;
        return d;
      }).filter(d => d.connectorId && d.model);
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
      vscodeApi.postMessage({ type: 'save', config: cfg, settings: readSettings() });
    });

    // ---- receive a loaded skill file from the extension (pickSkillFile round-trip) ----
    window.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'skillFileLoaded' && m.scope && m.key !== undefined && m.name) {
        const targetId = m.scope + ':' + m.key;
        if (!CHIPS.has(targetId)) return;
        SKILLS.set(targetId, { name: String(m.name), content: String(m.content || '') });
        renderChip(targetId);
      }
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
