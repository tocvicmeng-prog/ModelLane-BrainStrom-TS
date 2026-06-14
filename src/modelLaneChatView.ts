import * as vscode from 'vscode';
import { LMStudioApi } from './lmStudioApi';
import { ChatSession } from './chatSession';
import { ChatPanel, getNonce } from './chatPanel';

/**
 * Sidebar (activity-bar) webview view hosting ModelLane's original local-LLM chat — the
 * SAME UI and engine as the ModelLane editor panel, reused so the two features sit in
 * PARALLEL in the panel: this "ModelLane: Local LLM Chat" view and the "Brainstorm Live
 * Board" view share one container, and the user clicks between them (plus title-bar
 * buttons jump straight across). CSP-hardened: no remote content, empty localResourceRoots,
 * nonce-gated inline script (inherited from ChatPanel.getHtml).
 */
export class ModelLaneChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'modellane.chat';
  private _session?: ChatSession;

  constructor(private readonly _api: LMStudioApi) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    this._session = new ChatSession(this._api, (m) => webviewView.webview.postMessage(m));
    webviewView.webview.onDidReceiveMessage((m) => this._session?.handleMessage(m));
    webviewView.webview.html = ChatPanel.getHtml(webviewView.webview.cspSource, getNonce());
  }
}
