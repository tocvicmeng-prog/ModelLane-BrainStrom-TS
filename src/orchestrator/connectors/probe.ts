// probe.ts — a lightweight "Test connection" check per connector for the Configure panel.
//
// It never speaks the debate protocol or runs a model turn: it does the cheapest possible
// reachability + auth check and reports { ok, detail }. Every network probe goes through the
// SAME egress guard as the engine (makeGuardedFetch → validateEgress + assertResolvedHostSafe),
// so a probe can no more reach a private/metadata/non-allowlisted host than a real run can.
// The API key is read from SecretStorage by the caller and passed here as an argument; it is
// never logged and never returned. CLI connectors are checked locally (resolves on PATH),
// with no network and no model call.

import { spawn } from 'node:child_process';
import { fetchJson, HttpError, httpFetch } from '../../engine/http';
import { makeGuardedFetch, EgressError, DEFAULT_REMOTE_ALLOWLIST } from './egress';
import type { ConnectorDef } from '../../brainstorm/connectorRegistry';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

const PROBE_TIMEOUT_MS = 5000;

/** Reachability + auth check for one connector. Never throws. */
export async function probeConnector(
  def: ConnectorDef,
  apiKey: string | null,
  allowRemote: boolean,
): Promise<ProbeResult> {
  try {
    if (def.kind === 'cli') return await probeCli(def);
    if (def.kind === 'anthropic') return await probeHttp(anthropicModelsUrl(def.baseUrl), anthropicHeaders(apiKey), allowRemote);
    // openai + openai-compatible (local)
    return await probeHttp(joinUrl(def.baseUrl, 'models'), bearerHeaders(apiKey), allowRemote);
  } catch (e) {
    if (e instanceof EgressError) return { ok: false, detail: 'blocked by egress policy: ' + e.message };
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function joinUrl(base: string, path: string): string {
  return `${String(base || '').replace(/\/+$/, '')}/${path}`;
}

function anthropicModelsUrl(base: string): string {
  const trimmed = String(base || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function bearerHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function anthropicHeaders(apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

async function probeHttp(url: string, headers: Record<string, string>, allowRemote: boolean): Promise<ProbeResult> {
  const guarded = makeGuardedFetch(httpFetch, allowRemote, DEFAULT_REMOTE_ALLOWLIST);
  try {
    await fetchJson(url, { method: 'GET', headers }, PROBE_TIMEOUT_MS, guarded);
    return { ok: true, detail: 'reachable — models endpoint responded' };
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 401 || e.status === 403) return { ok: false, detail: 'reachable, but the API key was rejected (HTTP ' + e.status + ')' };
      if (e.status === 404) return { ok: false, detail: 'reached the host, but no models endpoint there (check the base URL / API path)' };
      if (e.status >= 500) return { ok: false, detail: 'server error (HTTP ' + e.status + ') — try again later' };
      return { ok: false, detail: 'HTTP ' + e.status };
    }
    if (e instanceof EgressError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: 'could not reach the endpoint (' + msg.slice(0, 120) + ')' };
  }
}

function toArgv(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string' && x.length > 0);
  if (typeof raw === 'string') return raw.trim().split(/\s+/).filter(Boolean);
  return [];
}

/** Local-only check: does the CLI command resolve and launch? (no network, no model call) */
function probeCli(def: ConnectorDef): Promise<ProbeResult> {
  const argv = toArgv(def.command);
  if (!argv.length) return Promise.resolve({ ok: false, detail: 'CLI command is empty' });
  const exe = argv[0]!;
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const done = (r: ProbeResult, child?: ReturnType<typeof spawn>) => {
      if (settled) return;
      settled = true;
      try { child?.kill(); } catch { /* ignore */ }
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Resolvability check ONLY: launch the executable with no arguments (so we never pass
      // the configured action flags, which could have a side effect), and kill it the moment
      // it spawns. ENOENT means the command is not on PATH.
      child = spawn(exe, [], { shell: false, stdio: 'ignore' });
    } catch (e) {
      resolve({ ok: false, detail: 'could not launch CLI: ' + (e instanceof Error ? e.message : String(e)) });
      return;
    }
    const timer = setTimeout(() => done({ ok: true, detail: `'${exe}' launches (not model-tested)` }, child), 2000);
    child.on('spawn', () => { clearTimeout(timer); done({ ok: true, detail: `'${exe}' resolves and launches (not model-tested)` }, child); });
    child.on('error', (e: any) => {
      clearTimeout(timer);
      done({ ok: false, detail: e && e.code === 'ENOENT' ? `not found on PATH: ${exe}` : `CLI launch failed: ${e?.message || e}` });
    });
  });
}
