import * as vscode from 'vscode';
import { LMStudioLanguageModelInfo, LMStudioLanguageModelProvider } from './languageModelProvider';
import { LocalModelInfo, LocalModelLanguageModelProvider } from './localModelProvider';

type DelegateProvider = LMStudioLanguageModelProvider | LocalModelLanguageModelProvider;
type DelegateModelInfo = LMStudioLanguageModelInfo | LocalModelInfo;

// A real model that wraps a delegate provider/model.
type DelegatedModelInfo = vscode.LanguageModelChatInformation & {
  kind: 'delegate';
  source: string;
  delegateProvider: DelegateProvider;
  delegateModel: DelegateModelInfo;
};

// The synthetic "Brainstorm Debate Model" has NO delegate — every method MUST branch
// on `kind` before touching delegate fields (ARCHITECTURE F2).
type BrainstormModelInfo = vscode.LanguageModelChatInformation & {
  kind: 'brainstrom';
  source: 'brainstrom';
};

type ModelLaneModelInfo = DelegatedModelInfo | BrainstormModelInfo;

export const BRAINSTORM_MODEL_ID = 'brainstrom:debate';

export type BrainstormHandler = (
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
) => Promise<void>;

export class ModelLaneLanguageModelProvider implements vscode.LanguageModelChatProvider<ModelLaneModelInfo> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private brainstormHandler?: BrainstormHandler;

  setBrainstormHandler(handler: BrainstormHandler): void {
    this.brainstormHandler = handler;
  }

  private brainstormModel(): BrainstormModelInfo {
    return {
      kind: 'brainstrom',
      source: 'brainstrom',
      id: BRAINSTORM_MODEL_ID,
      name: '🧠 Brainstorm Debate Model',
      family: 'brainstrom',
      version: '0.2.0',
      maxInputTokens: 32768,
      maxOutputTokens: 8192,
      detail: 'Multi-LLM moderated debate — decompose → group debates → report',
      tooltip: 'BrainStrom: orchestrates multiple debate models under a local moderator/scribe',
      capabilities: { imageInput: false, toolCalling: false }
    };
  }

  constructor(
    private readonly lmStudioProvider: LMStudioLanguageModelProvider,
    private readonly localProviders: LocalModelLanguageModelProvider[]
  ) { }

  refresh() {
    this.changeEmitter.fire();
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<ModelLaneModelInfo[]> {
    const results: ModelLaneModelInfo[] = [];

    try {
      const lmStudioModels = await this.lmStudioProvider.provideLanguageModelChatInformation(options, token) || [];
      results.push(...lmStudioModels
        .filter(model => model.loaded)
        .map(model => this.wrapModel('lmstudio', 'LM Studio', this.lmStudioProvider, model)));
    } catch (err) {
      console.warn('ModelLane LM Studio discovery failed', err);
    }

    for (const provider of this.localProviders) {
      if (token.isCancellationRequested) break;
      try {
        const models = await provider.provideLanguageModelChatInformation(options, token) || [];
        results.push(...models
          .filter(model => model.running)
          .map(model => this.wrapModel(provider.vendor, provider.displayName, provider, model)));
      } catch (err) {
        console.warn(`ModelLane ${provider.displayName} discovery failed`, err);
      }
    }

    results.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
    // Always offer the synthetic Brainstorm Debate Model, even when no local model is
    // loaded (it has no delegate) — appended after the sort (F2 / F12).
    results.push(this.brainstormModel());
    return results;
  }

  async provideLanguageModelChatResponse(
    model: ModelLaneModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (model.kind === 'brainstrom') {
      if (this.brainstormHandler) {
        await this.brainstormHandler(messages, options, progress, token);
      } else {
        progress.report(new vscode.LanguageModelTextPart(
          'The Brainstorm Debate backend is not configured yet. Open the BrainStrom panel and set up connectors.'));
      }
      return;
    }
    await (model.delegateProvider as any).provideLanguageModelChatResponse(model.delegateModel, messages, options, progress, token);
  }

  async provideTokenCount(model: ModelLaneModelInfo, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    if (model.kind === 'brainstrom') {
      // Estimate without ever touching a (non-existent) delegate (F2).
      const s = typeof text === 'string' ? text : JSON.stringify(text);
      return Math.max(1, Math.ceil(s.length / 4));
    }
    return (model.delegateProvider as any).provideTokenCount(model.delegateModel, text, token);
  }

  private wrapModel(
    source: string,
    sourceDisplayName: string,
    delegateProvider: DelegateProvider,
    delegateModel: DelegateModelInfo
  ): DelegatedModelInfo {
    const rawName = stripReadyPrefix(delegateModel.name);
    const name = `✓ ${rawName}`;
    const detail = [sourceDisplayName, delegateModel.detail].filter(Boolean).join(' - ');
    const tooltip = [
      `${rawName}`,
      `Source: ${sourceDisplayName}`,
      'Status: ready / running',
      delegateModel.tooltip
    ].filter(Boolean).join('\n');

    return {
      id: `${source}:${delegateModel.id}`,
      kind: 'delegate',
      source,
      delegateProvider,
      delegateModel,
      name,
      family: delegateModel.family,
      version: `${source}:${delegateModel.version}`,
      tooltip,
      detail,
      maxInputTokens: delegateModel.maxInputTokens,
      maxOutputTokens: delegateModel.maxOutputTokens,
      capabilities: delegateModel.capabilities
    };
  }
}

function stripReadyPrefix(value: string): string {
  return value.replace(/^(✓\s*READY|✓|○\s*NOT LOADED|\[(READY|NOT LOADED)])\s+/i, '');
}
