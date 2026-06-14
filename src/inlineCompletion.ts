import * as vscode from 'vscode';
import { LMStudioApi } from './lmStudioApi';

export function registerInlineCompletion(context: vscode.ExtensionContext, api: LMStudioApi) {
  const provider = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    {
      async provideInlineCompletionItems(document, position, _context, token) {
        const enabled = vscode.workspace.getConfiguration('lmstudio').get('enableInlineCompletion', false);
        if (!enabled) return;
        if (!vscode.workspace.isTrusted) return;
        if (token.isCancellationRequested) return;
        if (shouldSkipDocument(document)) return;

        const linePrefix = document.lineAt(position).text.slice(0, position.character);
        if (linePrefix.trim().length < 3) return;

        const beforeCursor = document.getText(new vscode.Range(
          new vscode.Position(Math.max(0, position.line - 30), 0), position
        ));
        if (containsSecretLikeContent(beforeCursor)) return;
        if (token.isCancellationRequested) return;

        try {
          const result = await api.chat([
            {
              role: 'system',
              content: 'You are a code completion engine. Complete the code at the cursor. Return ONLY the completion text, no explanations, no markdown. Match the existing indentation and style.'
            },
            {
              role: 'user',
              content: `Complete the code at <CURSOR>:\n\`\`\`${document.languageId}\n${beforeCursor}<CURSOR>\`\`\``
            }
          ]);

          if (!result || result.trim().length < 2) return;
          const item = new vscode.InlineCompletionItem(result.trim());
          return [item];
        } catch {
          return;
        }
      }
    }
  );
  context.subscriptions.push(provider);
}

function shouldSkipDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return true;

  const path = document.uri.fsPath.toLowerCase().replace(/\\/g, '/');
  return /(^|\/)\.env($|[./])/.test(path) ||
    /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts)$/.test(path) ||
    /(^|\/)(\.npmrc|\.pypirc|\.netrc|credentials|secrets?)(\.|$|\/)/.test(path) ||
    ((/(^|\/)(settings|launch)\.json$/.test(path)) && path.includes('/.vscode/'));
}

function containsSecretLikeContent(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\b(api[_-]?key|secret|token|password|passwd|authorization)\b\s*[:=]/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(text);
}
