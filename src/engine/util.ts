// Small dependency-free helpers for the debate engine.

import { createHash } from 'node:crypto';

/** Hex SHA-256 of a UTF-8 string (replaces hashlib.sha256(...).hexdigest()). */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Rough token estimate ~= chars / 4 (rounded up). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Clamp x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
