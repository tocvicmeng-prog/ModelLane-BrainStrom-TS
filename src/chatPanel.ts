import * as vscode from 'vscode';
import { LMStudioApi } from './lmStudioApi';
import { AgentRunner } from './agentRunner';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _api: LMStudioApi;
  private readonly _agent: AgentRunner;
  private _disposables: vscode.Disposable[] = [];
  private _history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];

  private constructor(panel: vscode.WebviewPanel, api: LMStudioApi) {
    this._panel = panel;
    this._api = api;
    this._agent = new AgentRunner(api);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(this._handleMessage.bind(this), null, this._disposables);
    this._panel.webview.html = this._getHtml();
  }

  static createOrShow(api: LMStudioApi) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'lmstudioChat',
      'ModelLane',
      column || vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    ChatPanel.currentPanel = new ChatPanel(panel, api);
  }

  private async _handleMessage(msg: unknown) {
    if (!isWebviewMessage(msg)) return;

    switch (msg.type) {
      case 'sendMessage':
        if (typeof msg.text === 'string') await this._handleSend(msg.text, msg.agentMode === true);
        break;
      case 'cancelRequest':
        this._api.cancelRequest();
        break;
      case 'insertCode':
        if (typeof msg.code === 'string') await this._insertCode(msg.code);
        break;
      case 'newChat':
        this._history = [];
        this._postMessage({ type: 'clearChat' });
        break;
    }
  }

  private async _handleSend(text: string, agentMode: boolean) {
    this._history.push({ role: 'user', content: text });
    this._postMessage({ type: 'addMessage', role: 'user', content: text });
    this._postMessage({ type: 'showThinking' });
    try {
      const fullContent = agentMode
        ? await this._runAgent(text)
        : await this._runChatStream();
      this._postMessage({ type: 'hideThinking' });
      this._history.push({ role: 'assistant', content: fullContent });
    } catch (err: any) {
      this._postMessage({ type: 'hideThinking' });
      this._postMessage({ type: 'addMessage', role: 'assistant', content: `**Error:** ${err.message}` });
    }
  }

  private async _runChatStream(): Promise<string> {
    let fullContent = '';
    for await (const chunk of this._api.chatStream(this._history)) {
      if (chunk.done) break;
      fullContent += chunk.content;
      this._postMessage({ type: 'streamContent', content: fullContent });
    }
    return fullContent;
  }

  private async _runAgent(text: string): Promise<string> {
    let fullContent = 'Agent mode\n';
    this._postMessage({ type: 'streamContent', content: fullContent });

    const priorConversation = this._history.slice(0, -1);
    for await (const update of this._agent.run(text, priorConversation)) {
      if (update.type === 'status') {
        fullContent += `\n- ${update.content}`;
      } else {
        fullContent += `\n\n${update.content}`;
      }
      this._postMessage({ type: 'streamContent', content: fullContent });
    }

    return fullContent;
  }

  private async _insertCode(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const picked = await vscode.window.showWarningMessage(
      'Insert generated code into the active editor?',
      { modal: true },
      'Insert'
    );
    if (picked === 'Insert') {
      await editor.edit(eb => eb.replace(editor.selection, code));
    }
  }

  private _postMessage(msg: any) {
    this._panel.webview.postMessage(msg);
  }

  private _getHtml(): string {
    const nonce = getNonce();
    const cspSource = this._panel.webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>ModelLane</title>
<style nonce="${nonce}">
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-editor-foreground); background: var(--vscode-sideBar-background); height: 100vh; display: flex; flex-direction: column; }
#header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
#header h1 { font-size: 13px; font-weight: 600; }
#header-actions { display: flex; gap: 4px; }
#header-actions button { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 4px 6px; font-size: 13px; border-radius: 4px; }
#header-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
#cancel-btn { display: none; }
#cancel-btn.visible { display: inline-block; }
#messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.msg { max-width: 92%; padding: 10px 12px; border-radius: 8px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
.msg.user { align-self: flex-end; background: var(--vscode-textLink-foreground); color: var(--vscode-editor-background); }
.msg.assistant { align-self: flex-start; background: var(--vscode-editor-inactiveSelectionBackground); }
.msg pre { background: var(--vscode-textBlockQuote-background); padding: 10px; border-radius: 6px; overflow-x: auto; margin: 8px 0; font-size: 12px; }
.msg pre code { font-family: var(--vscode-editor-font-family); }
.msg code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 3px; }
.code-lang { font-size: 11px; color: var(--vscode-textPreformat-foreground); margin-bottom: 4px; }
.msg .code-actions { margin-top: 4px; display: flex; gap: 4px; }
.msg .code-actions button { font-size: 11px; padding: 2px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
.msg .code-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
#input-area { padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; align-items: flex-end; }
#input { flex: 1; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); resize: none; min-height: 34px; max-height: 120px; outline: none; }
#input:focus { border-color: var(--vscode-focusBorder); }
#agent-toggle { padding: 6px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 12px; }
#agent-toggle.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
#send-btn { padding: 6px 14px; border: none; border-radius: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 13px; }
#send-btn:hover { background: var(--vscode-button-hoverBackground); }
#send-btn:disabled { opacity: 0.5; cursor: default; }
.thinking { display: none; padding: 8px 12px; font-style: italic; color: var(--vscode-textPreformat-foreground); font-size: 12px; }
.thinking.active { display: block; }
.thinking::after { content: ''; animation: dots 1.5s steps(4, end) infinite; }
@keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
</style>
</head>
<body>
<div id="header">
  <h1>ModelLane</h1>
  <div id="header-actions">
    <button id="new-chat-btn" title="New Chat">+</button>
    <button id="cancel-btn" title="Cancel">X</button>
  </div>
</div>
<div id="messages"></div>
<div id="thinking" class="thinking">Thinking</div>
<div id="input-area">
  <textarea id="input" placeholder="Ask ModelLane..." rows="1"></textarea>
  <button id="agent-toggle" title="Agent mode" aria-pressed="false">Agent</button>
  <button id="send-btn">Send</button>
</div>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const agentToggle = document.getElementById('agent-toggle');
  const thinking = document.getElementById('thinking');
  const cancelBtn = document.getElementById('cancel-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  let isStreaming = false;
  let agentMode = false;

  function sendMessage() {
    const text = input.value.trim();
    if (!text || isStreaming) return;
    input.value = '';
    input.style.height = 'auto';
    vscode.postMessage({ type: 'sendMessage', text, agentMode });
  }

  sendBtn.onclick = sendMessage;
  input.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };
  input.oninput = function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; };

  cancelBtn.onclick = function() { vscode.postMessage({ type: 'cancelRequest' }); };
  newChatBtn.onclick = function() { vscode.postMessage({ type: 'newChat' }); };
  agentToggle.onclick = function() {
    agentMode = !agentMode;
    agentToggle.classList.toggle('active', agentMode);
    agentToggle.setAttribute('aria-pressed', String(agentMode));
  };

  window.addEventListener('message', function(e) {
    const msg = e.data;
    switch (msg.type) {
      case 'addMessage':
        addMsg(msg.role, msg.content);
        break;
      case 'streamContent': {
        let last = messages.lastElementChild;
        if (last && last.classList.contains('assistant')) renderMessage(last, msg.content);
        else addMsg('assistant', msg.content);
        last = messages.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth' });
        break;
      }
      case 'showThinking':
        isStreaming = true;
        sendBtn.disabled = true;
        agentToggle.disabled = true;
        cancelBtn.classList.add('visible');
        thinking.classList.add('active');
        break;
      case 'hideThinking':
        isStreaming = false;
        sendBtn.disabled = false;
        agentToggle.disabled = false;
        cancelBtn.classList.remove('visible');
        thinking.classList.remove('active');
        break;
      case 'clearChat':
        messages.replaceChildren();
        break;
    }
  });

  function addMsg(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    renderMessage(div, content);
    messages.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth' });
  }

  function renderMessage(container, text) {
    container.replaceChildren();
    const value = String(text || '');
    const fence = /\`\`\`(\\w*)\\n([^]*?)\`\`\`/g;
    let lastIndex = 0;
    let match;

    while ((match = fence.exec(value)) !== null) {
      appendInlineMarkdown(container, value.slice(lastIndex, match.index));

      const pre = document.createElement('pre');
      if (match[1]) {
        const lang = document.createElement('div');
        lang.className = 'code-lang';
        lang.textContent = match[1];
        pre.appendChild(lang);
      }

      const code = document.createElement('code');
      code.textContent = match[2];
      pre.appendChild(code);
      container.appendChild(pre);
      lastIndex = fence.lastIndex;
    }

    appendInlineMarkdown(container, value.slice(lastIndex));
  }

  function appendInlineMarkdown(parent, text) {
    const pattern = /(\`([^\`]+)\`)|(\\*\\*([^*]+)\\*\\*)|(\\*([^*]+)\\*)|(\\n)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      appendTextWithBreaks(parent, text.slice(lastIndex, match.index));
      if (match[2]) appendElement(parent, 'code', match[2]);
      else if (match[4]) appendElement(parent, 'strong', match[4]);
      else if (match[6]) appendElement(parent, 'em', match[6]);
      else parent.appendChild(document.createElement('br'));
      lastIndex = pattern.lastIndex;
    }

    appendTextWithBreaks(parent, text.slice(lastIndex));
  }

  function appendElement(parent, tagName, text) {
    const element = document.createElement(tagName);
    element.textContent = text;
    parent.appendChild(element);
  }

  function appendTextWithBreaks(parent, text) {
    if (!text) return;
    const parts = text.split('\\n');
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) parent.appendChild(document.createElement('br'));
      if (parts[index]) parent.appendChild(document.createTextNode(parts[index]));
    }
  }
})();
</script>
</body>
</html>`;
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
}

function isWebviewMessage(value: unknown): value is { type: string; text?: unknown; code?: unknown; agentMode?: unknown } {
  return typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type?: unknown }).type === 'string';
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
