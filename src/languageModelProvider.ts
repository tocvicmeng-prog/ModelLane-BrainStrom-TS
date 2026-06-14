import * as vscode from 'vscode';
import { ChatMessage, LMStudioApi, ModelInfo } from './lmStudioApi';

export type LMStudioLanguageModelInfo = vscode.LanguageModelChatInformation & {
  lmstudioId: string;
  loaded: boolean;
};

export class LMStudioLanguageModelProvider implements vscode.LanguageModelChatProvider<LMStudioLanguageModelInfo> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(private readonly api: LMStudioApi) { }

  refresh() {
    this.changeEmitter.fire();
  }

  async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<LMStudioLanguageModelInfo[]> {
    const models = await this.api.listModels(toAbortSignal(token));
    return models
      .map(toLanguageModelInfo)
      .sort((a, b) => Number(b.loaded) - Number(a.loaded) || stripStatePrefix(a.name).localeCompare(stripStatePrefix(b.name)));
  }

  async provideLanguageModelChatResponse(
    model: LMStudioLanguageModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!model.loaded) {
      throw new Error(`"${stripStatePrefix(model.name)}" is installed in LM Studio but is not loaded. Load it in LM Studio first, then run "ModelLane: Sense and Refresh Installed Models".`);
    }

    const chatMessages = messages
      .map(toChatMessage)
      .filter((message): message is ChatMessage => Boolean(message?.content.trim()));

    for await (const chunk of this.api.chatStream(chatMessages, model.lmstudioId)) {
      if (token.isCancellationRequested || chunk.done) break;
      if (chunk.content) progress.report(new vscode.LanguageModelTextPart(stripReasoningNoise(chunk.content)));
    }
  }

  async provideTokenCount(_model: LMStudioLanguageModelInfo, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
    const value = typeof text === 'string' ? text : messagePartsToText(text.content);
    return Math.max(1, Math.ceil(value.length / 4));
  }
}

function toLanguageModelInfo(model: ModelInfo): LMStudioLanguageModelInfo {
  const loaded = Boolean(model.loaded);
  const baseName = model.name || model.id;
  const stateLabel = loaded ? '✓ READY' : '○ NOT LOADED';
  const statusDetail = loaded ? 'Ready to use now' : 'Not loaded in LM Studio';
  const detail = [statusDetail, model.detail].filter(Boolean).join(' - ');
  const tooltip = [
    `${stateLabel} ${baseName}`,
    loaded ? 'Status: ready / loaded in LM Studio' : 'Status: installed but not loaded in LM Studio',
    model.tooltip
  ].filter(Boolean).join('\n');

  return {
    id: model.id,
    lmstudioId: model.id,
    loaded,
    name: `${stateLabel} ${baseName}`,
    family: model.family || 'lmstudio',
    version: model.version || model.id,
    tooltip,
    detail,
    maxInputTokens: model.maxInputTokens || 32768,
    maxOutputTokens: model.maxOutputTokens || 8192,
    capabilities: {
      imageInput: model.imageInput || false,
      toolCalling: loaded && model.toolCalling ? 32 : false
    }
  };
}

function stripStatePrefix(value: string): string {
  return value.replace(/^(✓\s*READY|○\s*NOT LOADED|\[(READY|NOT LOADED)])\s+/i, '');
}

function toChatMessage(message: vscode.LanguageModelChatRequestMessage): ChatMessage | undefined {
  const content = messagePartsToText(message.content);
  switch (message.role) {
    case vscode.LanguageModelChatMessageRole.Assistant:
      return { role: 'assistant', content };
    case vscode.LanguageModelChatMessageRole.User:
      return { role: 'user', content };
    default:
      return undefined;
  }
}

function messagePartsToText(parts: ReadonlyArray<vscode.LanguageModelInputPart | unknown>): string {
  return parts
    .map(part => {
      if (part instanceof vscode.LanguageModelTextPart) return part.value;
      if (part instanceof vscode.LanguageModelToolResultPart) {
        return part.content.map(resultPart => {
          if (resultPart instanceof vscode.LanguageModelTextPart) return resultPart.value;
          return '';
        }).join('');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

function stripReasoningNoise(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|channel>thought\s*<channel\|>/gi, '')
    .replace(/<\|channel>final\s*<channel\|>/gi, '')
    .replace(/<end$/gi, '');
}
