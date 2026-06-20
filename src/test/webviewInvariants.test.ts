// webviewInvariants.test.ts — makes the DESIGN.md webview rules ENFORCED, not aspirational.
// Scans the webview source for (1) hard-coded colors (only --vscode-* tokens allowed; the one
// intentional exception is the help-popover drop-shadow tint rgba(0,0,0,.35)), (2) innerHTML of
// data (textContent-only), and (3) the strict CSP + empty localResourceRoots on each panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const PANELS = ['src/chatPanel.ts', 'src/brainstorm/brainstormViewProvider.ts', 'src/brainstorm/adminConsolePanel.ts'];
const COLOR_SCANNED = [...PANELS, 'src/webview/theme.ts'];

// the single allowed non-token color literal: the popover drop-shadow tint (DESIGN.md §1.3)
const ALLOWED_RGBA = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.\d+\s*\)/g;

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

for (const rel of COLOR_SCANNED) {
  test(`${rel}: only --vscode-* colors (no hex / rgb literal)`, () => {
    const src = read(rel);
    const stripped = src.replace(ALLOWED_RGBA, '');
    const rgb = stripped.match(/\brgba?\(/g) || [];
    assert.equal(rgb.length, 0, `${rel} has a disallowed rgb()/rgba(): ${rgb.join(', ')}`);
    // hex colors (#rgb/#rgba/#rrggbb/#rrggbbaa); exclude HTML numeric entities (&#NNNN;).
    const hex = (src.match(/(?<![&\w])#[0-9a-fA-F]{3,8}\b/g) || []).filter(h => [4, 5, 7, 9].includes(h.length));
    assert.equal(hex.length, 0, `${rel} has a hardcoded hex color: ${hex.join(', ')}`);
  });

  test(`${rel}: no innerHTML / insertAdjacentHTML of data`, () => {
    const src = read(rel);
    assert.ok(!/\.innerHTML\b/.test(src), `${rel} uses innerHTML`);
    assert.ok(!/insertAdjacentHTML/.test(src), `${rel} uses insertAdjacentHTML`);
  });
}

for (const rel of PANELS) {
  test(`${rel}: strict CSP + nonce + empty localResourceRoots`, () => {
    const src = read(rel);
    assert.match(src, /default-src 'none'/, `${rel} must set CSP default-src 'none'`);
    assert.match(src, /script-src 'nonce-/, `${rel} must nonce-gate scripts`);
    assert.match(src, /style-src 'nonce-/, `${rel} must nonce-gate styles`);
    assert.match(src, /localResourceRoots:\s*\[\s*\]/, `${rel} must pass empty localResourceRoots`);
  });
}
