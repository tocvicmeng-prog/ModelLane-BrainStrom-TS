import * as path from 'path';
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { ChatMessage, LMStudioApi } from './lmStudioApi';

type AgentInstruction = {
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
};

type AgentUpdate = {
  type: 'status' | 'final';
  content: string;
};

const AGENT_SYSTEM_PROMPT = `You are a careful local coding agent running inside VS Code.

You may inspect and edit only the current workspace through the tools below. Prefer small, reversible edits. Never invent file contents you have not read.

Available tools:
- active_editor_context: Get the active editor path and selection.
- list_files: {"pattern":"src/**/*.ts","maxResults":50}
- read_file: {"path":"src/example.ts","startLine":1,"endLine":160}
- search_text: {"query":"registerCommand","include":"src/**/*.ts","maxResults":30}
- replace_text: {"path":"src/example.ts","oldText":"exact text","newText":"replacement text"}
- create_file: {"path":"src/newFile.ts","content":"file content"}

Every response must be exactly one JSON object and nothing else.
To call a tool: {"tool":"read_file","args":{"path":"src/example.ts"}}
When finished: {"final":"Briefly explain what you changed or found."}
If a requested write is risky or unclear, finish with a question instead of calling a write tool.`;

export class AgentRunner {
  constructor(private readonly api: LMStudioApi) { }

  async *run(task: string, conversation: ChatMessage[] = []): AsyncGenerator<AgentUpdate> {
    if (!vscode.workspace.isTrusted) {
      yield {
        type: 'final',
        content: 'Agent mode is disabled in untrusted workspaces. Trust the workspace to allow file inspection and edits.'
      };
      return;
    }

    const workspaceFolder = this.getPrimaryWorkspaceFolder();
    if (!workspaceFolder) {
      yield { type: 'final', content: 'Open a workspace folder before using agent mode.' };
      return;
    }

    const maxIterations = vscode.workspace.getConfiguration('lmstudio').get('agent.maxIterations', 6);
    const messages: ChatMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...conversation.slice(-6),
      { role: 'user', content: `Task:\n${task}` }
    ];

    for (let step = 1; step <= maxIterations; step++) {
      const response = await this.api.chat(messages);
      const instruction = parseAgentInstruction(response);

      if (instruction.final) {
        yield { type: 'final', content: instruction.final };
        return;
      }

      if (!instruction.tool) {
        const content = response.trim() || 'The model did not return a tool call or final answer.';
        yield { type: 'final', content };
        return;
      }

      yield {
        type: 'status',
        content: `Step ${step}: ${instruction.tool}${formatArgsForStatus(instruction.args)}`
      };

      const result = await this.runTool(workspaceFolder, instruction.tool, instruction.args || {});
      messages.push({ role: 'assistant', content: response });
      messages.push({
        role: 'user',
        content: `Tool result for ${instruction.tool}:\n${truncateForPrompt(JSON.stringify(result, null, 2), 12000)}`
      });
    }

    yield {
      type: 'final',
      content: `Stopped after ${maxIterations} agent steps. Ask me to continue if you want another pass.`
    };
  }

  private async runTool(workspaceFolder: vscode.WorkspaceFolder, tool: string, args: Record<string, unknown>) {
    try {
      switch (tool) {
        case 'active_editor_context':
          return this.activeEditorContext(workspaceFolder);
        case 'list_files':
          return this.listFiles(args);
        case 'read_file':
          return await this.readFile(workspaceFolder, args);
        case 'search_text':
          return await this.searchText(args);
        case 'replace_text':
          return await this.replaceText(workspaceFolder, args);
        case 'create_file':
          return await this.createFile(workspaceFolder, args);
        default:
          return { ok: false, error: `Unknown tool: ${tool}` };
      }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  private activeEditorContext(workspaceFolder: vscode.WorkspaceFolder) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { ok: true, active: false };

    const document = editor.document;
    const relativePath = this.relativePath(workspaceFolder, document.uri);
    const selection = document.getText(editor.selection);
    const visibleRange = editor.visibleRanges[0];
    const context = visibleRange
      ? document.getText(new vscode.Range(visibleRange.start, visibleRange.end))
      : '';

    return {
      ok: true,
      active: true,
      path: relativePath,
      languageId: document.languageId,
      selection: truncateForPrompt(selection, 8000),
      visibleText: truncateForPrompt(context, 12000)
    };
  }

  private async listFiles(args: Record<string, unknown>) {
    const pattern = getStringArg(args, 'pattern') || '**/*';
    const maxResults = clampNumber(getNumberArg(args, 'maxResults') ?? 80, 1, 200);
    const files = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, maxResults);
    return {
      ok: true,
      files: files
        .map(uri => vscode.workspace.asRelativePath(uri, false))
        .filter(file => !isSensitivePath(file))
    };
  }

  private async readFile(workspaceFolder: vscode.WorkspaceFolder, args: Record<string, unknown>) {
    const target = this.resolveWorkspacePath(workspaceFolder, getRequiredStringArg(args, 'path'));
    const relativePath = this.relativePath(workspaceFolder, target);
    if (isSensitivePath(relativePath)) throw new Error(`Refusing to read sensitive path: ${relativePath}`);

    const content = await fs.readFile(target.fsPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const startLine = clampNumber(getNumberArg(args, 'startLine') ?? 1, 1, Math.max(1, lines.length));
    const endLine = clampNumber(getNumberArg(args, 'endLine') ?? Math.min(lines.length, startLine + 199), startLine, lines.length);
    const selected = lines.slice(startLine - 1, endLine).join('\n');

    return {
      ok: true,
      path: relativePath,
      startLine,
      endLine,
      totalLines: lines.length,
      content: truncateForPrompt(selected, 40000)
    };
  }

  private async searchText(args: Record<string, unknown>) {
    const query = getRequiredStringArg(args, 'query');
    const include = getStringArg(args, 'include') || '**/*';
    const maxResults = clampNumber(getNumberArg(args, 'maxResults') ?? 50, 1, 200);
    const files = await vscode.workspace.findFiles(include, DEFAULT_EXCLUDE, 300);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const needle = query.toLowerCase();

    for (const uri of files) {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      if (isSensitivePath(relativePath)) continue;

      let content = '';
      try {
        content = await fs.readFile(uri.fsPath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        matches.push({ path: relativePath, line: index + 1, text: lines[index].slice(0, 300) });
        if (matches.length >= maxResults) return { ok: true, matches };
      }
    }

    return { ok: true, matches };
  }

  private async replaceText(workspaceFolder: vscode.WorkspaceFolder, args: Record<string, unknown>) {
    const target = this.resolveWorkspacePath(workspaceFolder, getRequiredStringArg(args, 'path'));
    const relativePath = this.relativePath(workspaceFolder, target);
    if (isSensitivePath(relativePath)) throw new Error(`Refusing to edit sensitive path: ${relativePath}`);

    const oldText = getRequiredStringArg(args, 'oldText');
    const newText = getRequiredStringArg(args, 'newText');
    const content = await fs.readFile(target.fsPath, 'utf8');
    const firstIndex = content.indexOf(oldText);
    if (firstIndex < 0) throw new Error(`oldText was not found in ${relativePath}`);
    if (content.indexOf(oldText, firstIndex + oldText.length) >= 0) {
      throw new Error(`oldText appears more than once in ${relativePath}; include more surrounding context.`);
    }

    const picked = await vscode.window.showWarningMessage(
      `Apply agent edit to ${relativePath}?`,
      { modal: true },
      'Apply'
    );
    if (picked !== 'Apply') return { ok: false, cancelled: true, path: relativePath };

    await fs.writeFile(target.fsPath, content.replace(oldText, newText), 'utf8');
    return { ok: true, path: relativePath, changed: true };
  }

  private async createFile(workspaceFolder: vscode.WorkspaceFolder, args: Record<string, unknown>) {
    const target = this.resolveWorkspacePath(workspaceFolder, getRequiredStringArg(args, 'path'));
    const relativePath = this.relativePath(workspaceFolder, target);
    if (isSensitivePath(relativePath)) throw new Error(`Refusing to create sensitive path: ${relativePath}`);

    const content = getRequiredStringArg(args, 'content');
    try {
      await fs.access(target.fsPath);
      throw new Error(`${relativePath} already exists`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const picked = await vscode.window.showWarningMessage(
      `Create ${relativePath} from agent output?`,
      { modal: true },
      'Create'
    );
    if (picked !== 'Create') return { ok: false, cancelled: true, path: relativePath };

    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    await fs.writeFile(target.fsPath, content, 'utf8');
    return { ok: true, path: relativePath, created: true };
  }

  private getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder) return folder;
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  private resolveWorkspacePath(workspaceFolder: vscode.WorkspaceFolder, requestedPath: string): vscode.Uri {
    const normalized = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolute = path.resolve(workspaceFolder.uri.fsPath, normalized);
    const root = path.resolve(workspaceFolder.uri.fsPath);
    const relative = path.relative(root, absolute);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${requestedPath}`);
    }

    return vscode.Uri.file(absolute);
  }

  private relativePath(workspaceFolder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    return path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
  }
}

const DEFAULT_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.vscode-test/**,**/*.vsix,**/*.tgz}';

function parseAgentInstruction(text: string): AgentInstruction {
  const cleaned = text
    .replace(/<\|[^>]+>/g, '')
    .replace(/```json\s*/gi, '```')
    .trim();

  const fenced = cleaned.match(/```([\s\S]*?)```/);
  const candidate = fenced?.[1] || extractJsonObject(cleaned);
  if (!candidate) return {};

  try {
    return JSON.parse(candidate) as AgentInstruction;
  } catch {
    return {};
  }
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

function getRequiredStringArg(args: Record<string, unknown>, name: string): string {
  const value = getStringArg(args, name);
  if (!value) throw new Error(`Missing required string arg: ${name}`);
  return value;
}

function getStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function formatArgsForStatus(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const pathArg = getStringArg(args, 'path');
  const queryArg = getStringArg(args, 'query');
  const patternArg = getStringArg(args, 'pattern');
  const detail = pathArg || queryArg || patternArg;
  return detail ? ` (${detail})` : '';
}

function truncateForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[truncated ${text.length - maxLength} chars]`;
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  return /(^|\/)\.env($|[./])/.test(normalized) ||
    /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts)$/.test(normalized) ||
    /(^|\/)(\.npmrc|\.pypirc|\.netrc|credentials|secrets?)(\.|$|\/)/.test(normalized) ||
    ((/(^|\/)(settings|launch)\.json$/.test(normalized)) && normalized.includes('/.vscode/'));
}
