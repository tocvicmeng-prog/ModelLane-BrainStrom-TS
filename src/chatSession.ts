import * as vscode from 'vscode';
import { LMStudioApi } from './lmStudioApi';
import { AgentRunner } from './agentRunner';

type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Shared local-LLM chat engine — ModelLane's original "bring local models into a VS Code
 * chat box" capability. Used by BOTH the editor panel (ChatPanel) and the sidebar view
 * (ModelLaneChatViewProvider), so the two share identical behaviour and the sidebar chat
 * sits in parallel with the Brainstorm board. `post` delivers webview messages to whichever
 * host (panel or view) owns the webview.
 */
export class ChatSession {
  private readonly _api: LMStudioApi;
  private readonly _agent: AgentRunner;
  private readonly _post: (msg: any) => void;
  private _history: ChatTurn[] = [];

  constructor(api: LMStudioApi, post: (msg: any) => void) {
    this._api = api;
    this._agent = new AgentRunner(api);
    this._post = post;
  }

  async handleMessage(msg: unknown): Promise<void> {
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
        this._post({ type: 'clearChat' });
        break;
      case 'requestStatus':
        await this._postStatus();
        break;
    }
  }

  /** Probe the local model endpoint and push a status update to the webview header. */
  private async _postStatus(): Promise<void> {
    const s = await this._api.checkConnected();
    this._post({ type: 'status', model: s.model, connected: s.connected, error: s.error });
  }

  private async _handleSend(text: string, agentMode: boolean): Promise<void> {
    this._history.push({ role: 'user', content: text });
    this._post({ type: 'addMessage', role: 'user', content: text });
    this._post({ type: 'showThinking' });
    try {
      const fullContent = agentMode ? await this._runAgent(text) : await this._runChatStream();
      this._post({ type: 'hideThinking' });
      this._history.push({ role: 'assistant', content: fullContent });
    } catch (err: any) {
      this._post({ type: 'hideThinking' });
      this._post({ type: 'addMessage', role: 'assistant', content: `**Error:** ${err.message}` });
      void this._postStatus();
    }
  }

  private async _runChatStream(): Promise<string> {
    let fullContent = '';
    for await (const chunk of this._api.chatStream(this._history)) {
      if (chunk.done) break;
      fullContent += chunk.content;
      this._post({ type: 'streamContent', content: fullContent });
    }
    return fullContent;
  }

  private async _runAgent(text: string): Promise<string> {
    let fullContent = 'Agent mode\n';
    this._post({ type: 'streamContent', content: fullContent });
    const priorConversation = this._history.slice(0, -1);
    for await (const update of this._agent.run(text, priorConversation)) {
      if (update.type === 'status') fullContent += `\n- ${update.content}`;
      else fullContent += `\n\n${update.content}`;
      this._post({ type: 'streamContent', content: fullContent });
    }
    return fullContent;
  }

  private async _insertCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const picked = await vscode.window.showWarningMessage(
      'Insert generated code into the active editor?',
      { modal: true },
      'Insert'
    );
    if (picked === 'Insert') {
      await editor.edit((eb) => eb.replace(editor.selection, code));
    }
  }
}

function isWebviewMessage(value: unknown): value is { type: string; text?: unknown; code?: unknown; agentMode?: unknown } {
  return typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type?: unknown }).type === 'string';
}
