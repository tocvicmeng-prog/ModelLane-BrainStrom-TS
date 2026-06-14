// sessionState.ts (N11) — session lifecycle + redacted persistence.
//
// Persists per-group interim conclusions (and optionally full UnitResults) under a
// caller-provided base directory, which in production is the extension's
// `globalStorageUri` — never the repo or sidecar cwd (F5). Every string written to
// disk passes `redact` so no secret can land in a persisted artifact (S8/S14). This
// is the minimal store needed for the M1 walking skeleton + crash-resume seed.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redact } from './security';
import { GroupResult, SessionState, interimConclusionToDict } from './types';

export class SessionStore {
  readonly sessionId: string;
  readonly root: string;
  private readonly secrets: string[];

  constructor(baseDir: string, sessionId: string, secrets: string[] | null = null) {
    this.sessionId = sessionId;
    this.root = path.join(baseDir, 'sessions', sessionId);
    this.secrets = secrets ?? [];
  }

  private interimsDir(): string {
    const d = path.join(this.root, 'interims');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private redactObj(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return redact(obj, this.secrets);
    }
    if (Array.isArray(obj)) {
      return obj.map((x) => this.redactObj(x));
    }
    if (obj !== null && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = this.redactObj(v);
      }
      return out;
    }
    return obj;
  }

  /** Write the group's interim conclusion (redacted) to disk. Returns the path. */
  saveGroupResult(result: GroupResult): string | null {
    if (result.interim === null) {
      return null;
    }
    const filePath = path.join(this.interimsDir(), `${result.groupId}.json`);
    const payload = this.redactObj(interimConclusionToDict(result.interim));
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  }

  /** Persist a compact, redacted snapshot of session status + group ids. */
  saveState(state: SessionState): string {
    fs.mkdirSync(this.root, { recursive: true });
    const filePath = path.join(this.root, 'session.json');
    const payload = this.redactObj({
      session_id: state.sessionId,
      topic: state.topic,
      mode: state.mode,
      status: state.status,
      groups: state.results.map((r) => r.groupId),
    });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  }
}
