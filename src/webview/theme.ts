// theme.ts — shared primitives for the three CSP-hardened webviews (chat, board, Configure),
// so the things that MUST be identical don't drift apart.
//
// Scope is deliberate: only what is genuinely shared lives here. The per-panel CSS legitimately
// differs (the chat is a full-height flex column on the sidebar background; the board and the
// Configure panel are not), so there is no forced "base stylesheet" — that would invite visual
// regressions for no real dedup. What IS shared:
//   * nonce()   — the 32-char CSP nonce generator (was copied verbatim in all three panels);
//   * SWITCH_CSS — the canonical on/off switch (DESIGN.md §6.2), so every boolean control matches.
// Both use --vscode-* tokens only and are interpolated into a panel's nonce-gated <style>/<script>.

import { randomBytes } from 'node:crypto';

/** A fresh 32-char (128-bit) hex CSP nonce for a single webview render, from a CSPRNG
 *  (host-side). One source so every webview's style-src/script-src nonce is strong. */
export function nonce(): string {
  return randomBytes(16).toString('hex');
}

/** Canonical on/off switch CSS (DESIGN.md §6.2). All colors via --vscode-* tokens. */
export const SWITCH_CSS = `
    .switch { position: relative; display: inline-block; width: 34px; height: 18px; }
    .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
    .switch .slider { position: absolute; inset: 0; cursor: pointer; border-radius: 18px;
            background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); transition: background .15s; }
    .switch .slider::before { content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px;
            border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform .15s, background .15s; }
    .switch input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    .switch input:checked + .slider::before { transform: translateX(16px); background: var(--vscode-button-foreground); }
    .switch input:focus-visible + .slider { outline: 1px solid var(--vscode-focusBorder); }`;
