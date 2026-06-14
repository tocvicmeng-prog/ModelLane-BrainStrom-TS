import * as vscode from 'vscode';
import { LMStudioApi } from './lmStudioApi';

interface ModelInfo {
  id: string;
  name?: string;
  loaded?: boolean;
}

export function registerStatusBar(context: vscode.ExtensionContext, api: LMStudioApi) {
  const statusItem = vscode.window.createStatusBarItem('lmstudio.status', vscode.StatusBarAlignment.Right, 10000);
  statusItem.name = 'ModelLane';
  statusItem.command = 'lmstudio.selectModel';
  statusItem.accessibilityInformation = {
    label: 'ModelLane status',
    role: 'button'
  };
  let cachedModels: ModelInfo[] = [];

  updateStatus();

  const modelWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('lmstudio')) {
      api.refreshConfig();
      updateStatus();
    }
  });
  context.subscriptions.push(statusItem, modelWatcher);

  const selectModelCmd = vscode.commands.registerCommand('lmstudio.selectModel', async () => {
    try {
      statusItem.text = '$(loading~spin) $(server) ModelLane';
      const models = await api.listModels();
      cachedModels = models;
      
      const items = models.map(m => ({
        label: `${m.loaded ? '$(check) ' : '$(circle-slash) '}${m.name || m.id}`,
        description: m.id,
        detail: m.loaded ? 'Loaded' : 'Not loaded',
        id: m.id
      }));
      
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select LM Studio model',
        title: `ModelLane: Select LM Studio Model (${models.length} available)`
      });
      
      if (picked) {
        const config = vscode.workspace.getConfiguration('lmstudio');
        await config.update('model', picked.id, vscode.ConfigurationTarget.Workspace);
        api.refreshConfig();
        await updateStatus();
        vscode.window.showInformationMessage(`LM Studio model: ${picked.label.replace(/^\$\([^)]+\)\s/, '')}`);
      } else {
        await updateStatus();
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cannot reach LM Studio: ${err.message}`);
      statusItem.text = '$(server) ModelLane';
    }
  });
  context.subscriptions.push(selectModelCmd);

  const showStatusCmd = vscode.commands.registerCommand('lmstudio.showStatus', async () => {
    try {
      await updateStatus();
      vscode.window.showInformationMessage('ModelLane status refreshed and visible in the status bar.');
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to refresh ModelLane status: ${err.message}`);
    }
  });
  context.subscriptions.push(showStatusCmd);

  async function updateStatus() {
    const model: string = vscode.workspace.getConfiguration('lmstudio').get('model', '') || '';
    const baseUrl: string = vscode.workspace.getConfiguration('lmstudio').get('baseUrl', 'http://localhost:1234');
    
    if (!model || model.toLowerCase() === 'auto') {
      // Auto-detection mode
      statusItem.text = '$(server) ModelLane: LM Studio Auto';
      const tooltipParts = [
        `**Auto-detection enabled**`,
        `The extension will automatically select the best available model.`,
        `Server: ${baseUrl}`,
        '',
        'Click to manually select a model'
      ];
      statusItem.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
      statusItem.show();
      return;
    }

    // Find the model in cache to get loaded status
    const modelInfo = cachedModels.find(m => m.id === model);
    const isLoaded = modelInfo?.loaded ?? true; // Assume loaded if not in cache
    const modelDisplay = model.split('/').pop() || model;
    const statusIcon = isLoaded ? '$(check)' : '$(circle-slash)';

    statusItem.text = `${statusIcon} $(server) ModelLane: ${modelDisplay}`;
    
    const tooltipParts = [
      `**Model:** ${model}`,
      `**Status:** ${isLoaded ? 'Loaded ✓' : 'Not loaded ⊘'}`,
      `**Server:** ${baseUrl}`,
      '',
      'Click to change model'
    ];
    statusItem.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
    statusItem.show();
  }
}
