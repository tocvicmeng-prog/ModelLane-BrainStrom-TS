import * as vscode from 'vscode';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  loaded?: boolean;
  detail?: string;
  tooltip?: string;
  family?: string;
  version?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  imageInput?: boolean;
  toolCalling?: boolean;
}

interface StreamChunk {
  content: string;
  done: boolean;
}

export class LMStudioApi {
  private baseUrl: string;
  private modelId: string;
  private apiMode: 'native' | 'openai';
  private allowRemoteBaseUrl = false;
  private remoteBaseUrlIsUserConfigured = false;
  private abortControllers = new Set<AbortController>();

  constructor() {
    this.baseUrl = '';
    this.modelId = '';
    this.apiMode = 'native';
    this.refreshConfig();
  }

  refreshConfig() {
    const config = vscode.workspace.getConfiguration('lmstudio');
    const inspectedBaseUrl = config.inspect<string>('baseUrl');
    this.baseUrl = config.get('baseUrl', 'http://localhost:1234').trim();
    this.modelId = config.get('model', '');
    this.apiMode = config.get<'native' | 'openai'>('apiMode', 'native');

    // Remote endpoints are a privacy boundary, so only a user-level setting can enable them.
    this.allowRemoteBaseUrl = Boolean(config.inspect<boolean>('allowRemoteBaseUrl')?.globalValue);
    this.remoteBaseUrlIsUserConfigured = this.normalizeForCompare(inspectedBaseUrl?.globalValue) === this.normalizeForCompare(this.baseUrl);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(this.buildEndpoint(this.apiMode === 'native' ? '/api/v1/models' : '/v1/models'), { signal });
    if (!res.ok) {
      throw new Error(`LM Studio API error (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
    }
    const data: any = await res.json();
    if (this.apiMode === 'native') {
      return (data.models || [])
        .filter((m: any) => m.type === 'llm')
        .map((m: any) => {
          const loadedInstanceId = m.loaded_instances?.[0]?.id;
          const id = m.key || loadedInstanceId;
          const params = m.params_string ? `${m.params_string}` : '';
          const quantization = m.quantization?.name ? `${m.quantization.name}` : '';
          const detail = [m.loaded_instances?.length ? 'Loaded in LM Studio' : 'Installed only', params, quantization].filter(Boolean).join(' - ');
          return {
            id,
            name: m.display_name || m.key,
            loaded: Boolean(loadedInstanceId),
            detail,
            tooltip: [
              m.display_name || m.key,
              `ID: ${id}`,
              loadedInstanceId ? `Loaded instance: ${loadedInstanceId}` : 'Not loaded',
              m.publisher ? `Publisher: ${m.publisher}` : '',
              m.architecture ? `Architecture: ${m.architecture}` : '',
              m.params_string ? `Parameters: ${m.params_string}` : '',
              m.max_context_length ? `Context: ${m.max_context_length}` : ''
            ].filter(Boolean).join('\n'),
            family: normalizeFamily(m.architecture || m.key),
            version: m.key || id,
            maxInputTokens: m.max_context_length || 32768,
            maxOutputTokens: 8192,
            imageInput: Boolean(m.capabilities?.vision),
            toolCalling: Boolean(m.capabilities?.trained_for_tool_use)
          };
        });
    }

    return (data.data || []).map((m: any) => ({
      id: m.id,
      name: m.id.split('/').pop() || m.id,
      loaded: true,
      detail: 'OpenAI-compatible',
      tooltip: m.id,
      family: normalizeFamily(m.id),
      version: m.id,
      maxInputTokens: 32768,
      maxOutputTokens: 8192,
      imageInput: false,
      toolCalling: true
    }));
  }

  async autoSelectModel(signal?: AbortSignal): Promise<string> {
    const models = await this.listModels(signal);
    if (models.length === 0) throw new Error('No models found in LM Studio. Make sure a model is loaded.');
    const loadedModels = models.filter(m => m.loaded);
    const candidates = loadedModels.length > 0 ? loadedModels : models;
    const preferred = candidates.find(m =>
      m.id.toLowerCase().includes('qwen') ||
      m.id.toLowerCase().includes('codestral') ||
      m.id.toLowerCase().includes('codeqwen') ||
      m.id.toLowerCase().includes('gemma')
    );
    this.modelId = (preferred || candidates[0]).id;
    return this.modelId;
  }

  getModel(): string {
    return this.modelId;
  }

  cancelRequest() {
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  async *chatStream(messages: ChatMessage[], modelOverride?: string): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const signal = controller.signal;
    let reader: any;

    try {
      let model = modelOverride || this.modelId;
      if (!model) model = await this.autoSelectModel(signal);

      const maxTokens = vscode.workspace.getConfiguration('lmstudio').get('maxTokens', 4096);
      const temperature = vscode.workspace.getConfiguration('lmstudio').get('temperature', 0.7);

      const res = await fetch(this.buildEndpoint(this.apiMode === 'native' ? '/api/v1/chat' : '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildChatBody(model, messages, maxTokens, temperature)),
        signal
      });

      if (!res.ok) {
        throw new Error(`LM Studio API error (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
      }

      if (!res.body) throw new Error('LM Studio API returned an empty response body.');

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const chunk = this.parseStreamFrame(frame);
          if (chunk.done) { yield chunk; return; }
          if (chunk.content) yield chunk;
        }
      }
    } finally {
      reader?.releaseLock();
      this.abortControllers.delete(controller);
    }
    yield { content: '', done: true };
  }

  async chat(messages: ChatMessage[], modelOverride?: string): Promise<string> {
    let result = '';
    for await (const chunk of this.chatStream(messages, modelOverride)) {
      result += chunk.content;
      if (chunk.done) break;
    }
    return result;
  }

  private buildChatBody(model: string, messages: ChatMessage[], maxTokens: number, temperature: number) {
    if (this.apiMode === 'native') {
      return {
        model,
        input: this.messagesToNativeInput(messages),
        max_output_tokens: maxTokens,
        temperature,
        store: false,
        stream: true
      };
    }

    return {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true
    };
  }

  private messagesToNativeInput(messages: ChatMessage[]): string {
    const system = messages
      .filter(message => message.role === 'system')
      .map(message => message.content.trim())
      .filter(Boolean);

    const conversation = messages
      .filter(message => message.role !== 'system')
      .map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
      .join('\n\n');

    return [
      system.length ? `System instructions:\n${system.join('\n\n')}` : '',
      conversation
    ].filter(Boolean).join('\n\n');
  }

  private parseStreamFrame(frame: string): StreamChunk {
    const lines = frame.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '';
    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');

    if (!data) return { content: '', done: false };
    if (data === '[DONE]') return { content: '', done: true };

    try {
      const parsed = JSON.parse(data);
      const type = parsed.type || event;
      if (type === 'error') {
        throw new Error(parsed.error?.message || 'LM Studio API stream error.');
      }

      const nativeContent = type === 'message.delta' ? parsed.content : '';
      const openAiContent = parsed.choices?.[0]?.delta?.content || '';
      const content = nativeContent || openAiContent;
      return { content, done: type === 'chat.end' };
    } catch (err: any) {
      if (err instanceof Error && err.message !== 'Unexpected end of JSON input') throw err;
      return { content: '', done: false };
    }
  }

  private buildEndpoint(path: string): string {
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      throw new Error('Invalid lmstudio.baseUrl. Use a full http:// or https:// URL.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Invalid lmstudio.baseUrl. Only http:// and https:// endpoints are supported.');
    }

    if (url.username || url.password) {
      throw new Error('Invalid lmstudio.baseUrl. Credentials in the URL are not supported.');
    }

    if (!this.isLoopbackHost(url.hostname) && (!this.allowRemoteBaseUrl || !this.remoteBaseUrlIsUserConfigured)) {
      throw new Error(
        `Refusing to send code to non-local LM Studio API host "${url.hostname}". ` +
        'Use localhost/127.0.0.1, or set both lmstudio.baseUrl and lmstudio.allowRemoteBaseUrl in user settings only if you trust the endpoint.'
      );
    }

    const basePath = url.pathname.replace(/\/+$/, '');
    const endpointPath = path.startsWith('/') ? path : `/${path}`;
    url.pathname = `${basePath}${endpointPath}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host === '::1') return true;

    const ipv4 = host.split('.').map(part => Number(part));
    return ipv4.length === 4 &&
      ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
      ipv4[0] === 127;
  }

  private normalizeForCompare(value: string | undefined): string {
    return (value || '').trim().replace(/\/+$/, '');
  }
}

function normalizeFamily(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('gemma')) return 'gemma';
  if (lower.includes('codestral')) return 'codestral';
  if (lower.includes('llama')) return 'llama';
  if (lower.includes('mistral')) return 'mistral';
  return lower.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lmstudio';
}
