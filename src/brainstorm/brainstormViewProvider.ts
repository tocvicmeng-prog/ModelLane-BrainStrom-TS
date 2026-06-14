import * as vscode from 'vscode';
import { EngineEvent } from './engineService';

/**
 * brainstormViewProvider.ts (N18) — the live sidebar board.
 *
 * Renders GROUP/PHASE-grain events (group.start / group.phase / group.interim /
 * group.error) as they stream from the in-process engine. SECURITY (handover/DESIGN.md §6 /
 * CONSTITUTION S7): CSP `default-src 'none'`, no remote content, empty
 * localResourceRoots, a nonce-gated inline script, and ALL model-produced text is
 * rendered via `textContent` (never innerHTML). Markdown is only ever rendered in the
 * saved report file, never here.
 */
export class BrainstormViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'brainstrom.board';
  private view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) { }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.html(webviewView.webview);
  }

  /** Forward an engine event to the board (best-effort; no-op if the view is closed). */
  postEvent(event: EngineEvent): void {
    this.view?.webview.postMessage(event);
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           font-size: var(--vscode-font-size); padding: 8px; }
    h3 { margin: 0 0 8px; font-size: 1.1em; }
    .empty { color: var(--vscode-descriptionForeground); }
    .ev { padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .kind { color: var(--vscode-textLink-foreground); font-weight: 600; margin-right: 6px; }
    .payload { color: var(--vscode-descriptionForeground); white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h3>BrainStrom — Live Board</h3>
  <div id="empty" class="empty">
    No active session yet.<br /><br />
    <b>1.</b> Run <b>BrainStrom: Configure</b> (Command Palette, or the &#9881; button in this view's title bar)
    to add your debate models — the <b>Codex</b> / <b>Claude</b> CLIs, or OpenAI / Anthropic / local APIs.<br />
    <b>2.</b> In Chat, pick the &#129504; <b>Brainstorm Debate Model</b> and type a topic.
  </div>
  <div id="log" role="log" aria-live="polite"></div>
  <script nonce="${nonce}">
    const log = document.getElementById('log');
    const empty = document.getElementById('empty');
    window.addEventListener('message', (e) => {
      const m = e.data || {};
      if (empty) { empty.style.display = 'none'; }
      const row = document.createElement('div');
      row.className = 'ev';
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = String(m.method || 'event');           // textContent — never innerHTML
      const payload = document.createElement('span');
      payload.className = 'payload';
      let text;
      try { text = JSON.stringify(m.params); } catch (_) { text = String(m.params); }
      payload.textContent = text || '';
      row.appendChild(kind);
      row.appendChild(payload);
      log.appendChild(row);
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
