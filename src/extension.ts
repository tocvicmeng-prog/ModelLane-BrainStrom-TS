import * as vscode from 'vscode';
import { LMStudioApi } from './lmStudioApi';
import { ChatPanel } from './chatPanel';
import { registerCodeActions } from './codeActions';
import { registerInlineCompletion } from './inlineCompletion';
import { registerStatusBar } from './statusBar';
import { LMStudioLanguageModelProvider } from './languageModelProvider';
import { createLocalModelProviders, LocalModelProbeResult } from './localModelProvider';
import { ModelLaneLanguageModelProvider } from './modelLaneProvider';
import { BrainstormViewProvider } from './brainstorm/brainstormViewProvider';
import { SecretsStore } from './brainstorm/secrets';
import { ConnectorRegistry } from './brainstorm/connectorRegistry';
import { BrainstormController } from './brainstorm/controller';
import { EngineService } from './brainstorm/engineService';
import { AdminConsolePanel } from './brainstorm/adminConsolePanel';

let api: LMStudioApi;

export function activate(context: vscode.ExtensionContext) {
  api = new LMStudioApi();

  // Register a command without letting a DUPLICATE id (e.g. a co-installed original
  // ModelLane) throw and abort our activation.
  const reg = (id: string, handler: (...args: any[]) => any) => {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    } catch (err) {
      console.warn(`ModelLane-BrainStrom: command '${id}' not registered (already in use?)`, err);
    }
  };
  const guard = (label: string, fn: () => void) => {
    try { fn(); } catch (err) { console.warn(`ModelLane-BrainStrom: ${label} failed`, err); }
  };

  const languageModelProvider = new LMStudioLanguageModelProvider(api);
  const localModelProviders = createLocalModelProviders();
  const modelLaneProvider = new ModelLaneLanguageModelProvider(languageModelProvider, localModelProviders);

  // --- BrainStrom core: registered FIRST, under a UNIQUE vendor, so it can never be
  // shadowed by (or collide with) a co-installed ModelLane. The debate engine now runs
  // IN-PROCESS (no Python sidecar): EngineService forwards events straight to the board
  // and reads secrets from the controller's in-memory snapshot. ---
  const bsLog = vscode.window.createOutputChannel('ModelLane-BrainStrom');
  const board = new BrainstormViewProvider(context.extensionUri);
  const secretsStore = new SecretsStore(context.secrets);
  const registry = new ConnectorRegistry(context.globalState);
  const controller = new BrainstormController(registry, secretsStore, context, bsLog);
  // Engine emits events to the live board; reads secrets from the controller's snapshot
  // (collected one-shot per run, S2). Injected back into the controller after construction.
  const engine = new EngineService(ev => board.postEvent(ev), () => controller.getSecrets());
  controller.setEngine(engine);
  const adminConsole = new AdminConsolePanel(context.extensionUri, registry, secretsStore);
  context.subscriptions.push(bsLog);
  modelLaneProvider.setBrainstormHandler((messages, _options, progress, cancelToken) =>
    controller.run(messages, progress, cancelToken));
  guard('BrainStrom view', () => context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BrainstormViewProvider.viewType, board)));
  guard('LM provider', () => context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('modellane-brainstrom', modelLaneProvider)));
  reg('brainstrom.openBoard', () => vscode.commands.executeCommand('brainstrom.board.focus'));
  reg('brainstrom.configure', () => adminConsole.open());

  // --- inherited ModelLane features (all guarded so a co-installed ModelLane cannot
  // abort our activation on a duplicate command id) ---
  reg('lmstudio.diagnostics', async () => {
    const config = vscode.workspace.getConfiguration('lmstudio');
    const version = context.extension.packageJSON.version || 'unknown';
    const installPath = context.extensionUri.fsPath;
    const model = config.get('model', '') || 'Auto';
    const baseUrl = config.get('baseUrl', 'http://localhost:1234');
    const apiMode = config.get('apiMode', 'native');
    vscode.window.showInformationMessage(
      `ModelLane-BrainStrom v${version} active. LM Studio API: ${apiMode} ${baseUrl}. Model: ${model}. Path: ${installPath}`
    );
  });
  reg('lmstudio.chat', () => ChatPanel.createOrShow(api));
  guard('code actions', () => registerCodeActions(context, api));
  guard('inline completion', () => registerInlineCompletion(context, api));
  guard('status bar', () => registerStatusBar(context, api));
  reg('lmstudio.refreshLanguageModels', async () => {
    api.refreshConfig();
    languageModelProvider.refresh();
    localModelProviders.forEach(provider => provider.refresh());
    modelLaneProvider.refresh();
    vscode.window.showInformationMessage('ModelLane-BrainStrom models refreshed.');
  });
  reg('lmstudio.senseLocalModels', async () => {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'ModelLane-BrainStrom: sensing local model platforms',
      cancellable: true
    }, async (progress, token) => {
      api.refreshConfig();
      const results: LocalModelProbeResult[] = [];
      progress.report({ message: 'Checking LM Studio...' });
      results.push(await probeLMStudio(api, token));
      for (const provider of localModelProviders) {
        if (token.isCancellationRequested) return;
        progress.report({ message: `Checking ${provider.displayName}...` });
        results.push(await provider.probe(token));
      }
      languageModelProvider.refresh();
      localModelProviders.forEach(provider => provider.refresh());
      modelLaneProvider.refresh();
      if (!token.isCancellationRequested) {
        vscode.window.showInformationMessage(formatProbeResults(results));
      }
    });
  });
  guard('status item', () => {
    const status = vscode.window.createStatusBarItem('modellane.brainstrom.sense', vscode.StatusBarAlignment.Right, 9999);
    status.name = 'ModelLane-BrainStrom';
    status.text = '$(sync) BrainStrom Refresh';
    status.tooltip = 'Sense and refresh installed local models for VS Code Chat';
    status.command = 'lmstudio.senseLocalModels';
    status.show();
    context.subscriptions.push(status);
  });

  console.log('ModelLane-BrainStrom extension activated');
}

export function deactivate() {
  if (ChatPanel.currentPanel) {
    ChatPanel.currentPanel.dispose();
  }
}

async function probeLMStudio(api: LMStudioApi, token: vscode.CancellationToken): Promise<LocalModelProbeResult> {
  const baseUrl = vscode.workspace.getConfiguration('lmstudio').get<string>('baseUrl', 'http://localhost:1234');
  try {
    const models = await api.listModels(toAbortSignal(token));
    return {
      displayName: 'LM Studio',
      baseUrl,
      reachable: true,
      available: models.length,
      running: models.filter(model => model.loaded).length
    };
  } catch (err: any) {
    return {
      displayName: 'LM Studio',
      baseUrl,
      reachable: false,
      available: 0,
      running: 0,
      error: err?.message || String(err)
    };
  }
}

function formatProbeResults(results: LocalModelProbeResult[]): string {
  const parts = results.map(result => {
    if (!result.reachable) return `${result.displayName}: offline`;
    return `${result.displayName}: ${result.running}/${result.available} running`;
  });
  return `Local model scan complete. ${parts.join('; ')}.`;
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
