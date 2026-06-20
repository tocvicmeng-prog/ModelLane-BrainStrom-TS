// egress.ts (N4) — the total egress guard.
//
// Every connector validates its base URL through `validateEgress` at construction
// AND before each client build. Policy (CONSTITUTION S4/S5):
//
//   * loopback / private / link-local hosts are allowed (local models: LM Studio,
//     llama.cpp, Ollama) — the default, privacy-preserving posture;
//   * cloud-metadata endpoints (169.254.169.254 and friends) are ALWAYS blocked;
//   * remote hosts require an explicit `allowRemote` opt-in AND membership in an
//     allowlist AND https.
//
// `validateEgress` classifies by hostname only (no DNS). `makeGuardedFetch` then adds a
// resolve-and-recheck pass before each request (audit F9 / Risk R2 / S5): the host is
// resolved and every returned address is re-classified, so an allowlisted name that
// resolves to a private / link-local / metadata address is blocked (DNS-rebinding defence).

import { lookup } from 'node:dns/promises';
import * as net from 'node:net';
import { httpFetch, type FetchLike } from '../../engine/http';

// Cloud metadata / link-local service endpoints that must never be reached.
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure IMDS
  'metadata.google.internal',
  '100.100.100.100', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv6
]);

// Default remote allowlist for the built-in API connectors.
export const DEFAULT_REMOTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'api.openai.com',
  'api.anthropic.com',
]);

// Allowlist for the external research providers (audit F1). Research is remote by
// nature; it is routed through a guarded fetch restricted to exactly these hosts, so
// even research can never reach an arbitrary, private, or metadata address.
export const RESEARCH_ALLOWLIST: ReadonlySet<string> = new Set([
  'en.wikipedia.org',
  'api.semanticscholar.org',
  'eutils.ncbi.nlm.nih.gov',
  'export.arxiv.org',
]);

/** Raised when a base URL violates the egress policy. */
export class EgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

/** Lowercased hostname of a base URL (empty string if none). */
function hostOf(baseUrl: string): string {
  try {
    return (new URL(baseUrl).hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

// --- manual IP classification (replaces Python ipaddress, no extra deps) ---

/** Strip the IPv6 bracket/zone forms WHATWG URL leaves on a hostname. */
function normaliseIpLiteral(host: string): string {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  const pct = h.indexOf('%'); // drop a zone id (fe80::1%eth0)
  if (pct !== -1) {
    h = h.slice(0, pct);
  }
  return h;
}

/** Parse the four octets of an IPv4 literal, or null if not dotted-quad. */
function parseIpv4(host: string): [number, number, number, number] | null {
  if (net.isIPv4(host) !== true) {
    return null;
  }
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((p) => Number(p));
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** is_loopback || is_private || is_link_local for an IPv4 literal. */
function ipv4IsLocal(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 127) return true; // 127.0.0.0/8  loopback
  if (a === 10) return true; // 10.0.0.0/8   private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  // Remaining ranges Python's ipaddress.is_private also treats as private, so the
  // guard stays faithful to the sidecar (e.g. a local model bound to 0.0.0.0 must
  // be reachable).
  if (a === 0) return true; // 0.0.0.0/8    "this host"
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 240) return true; // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** Expand an IPv6 literal to its 8 hextets, or null if malformed. */
function expandIpv6(host: string): number[] | null {
  if (net.isIPv6(host) !== true) {
    return null;
  }
  // Handle an embedded IPv4 tail (e.g. ::ffff:127.0.0.1) by converting it.
  let h = host;
  const lastColon = h.lastIndexOf(':');
  const tail = h.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) {
      return null;
    }
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    h =
      h.slice(0, lastColon + 1) +
      hi.toString(16) +
      ':' +
      lo.toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0]!.split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1]!.split(':') : []) : null;
  let groups: string[];
  if (back === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - back.length;
    if (missing < 0) {
      return null;
    }
    groups = [...head, ...new Array(missing).fill('0'), ...back];
  }
  if (groups.length !== 8) {
    return null;
  }
  return groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
}

/** is_loopback || is_private || is_link_local for an IPv6 literal. */
function ipv6IsLocal(host: string): boolean {
  const g = expandIpv6(host);
  if (g === null) {
    return false;
  }
  // IPv4-mapped (::ffff:a.b.c.d): reclassify by the embedded IPv4 (Python does too).
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return ipv4IsLocal([(g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff]);
  }
  // ::1 loopback
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true;
  }
  // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfe80) {
    return true;
  }
  // fc00::/7 unique-local (Python is_private)
  if ((g[0]! & 0xfe00) === 0xfc00) {
    return true;
  }
  // 2001:db8::/32 documentation range (Python is_private)
  if (g[0] === 0x2001 && g[1] === 0x0db8) {
    return true;
  }
  return false;
}

/** True for loopback / private / link-local hosts (allowed by default). */
export function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host === 'ip6-localhost') {
    return true;
  }
  const lit = normaliseIpLiteral(host);
  const v4 = parseIpv4(lit);
  if (v4 !== null) {
    return ipv4IsLocal(v4);
  }
  if (net.isIPv6(lit)) {
    return ipv6IsLocal(lit);
  }
  return false; // a DNS name, not a literal IP → treated as remote
}

/** Throw `EgressError` unless `baseUrl` satisfies the egress policy. */
export function validateEgress(
  baseUrl: string,
  allowRemote = false,
  allowlist: ReadonlySet<string> = DEFAULT_REMOTE_ALLOWLIST,
): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new EgressError(`no host in base_url ${JSON.stringify(baseUrl)}`);
  }
  const host = (parsed.hostname || '').toLowerCase();
  if (!host) {
    throw new EgressError(`no host in base_url ${JSON.stringify(baseUrl)}`);
  }
  // METADATA_HOSTS uses bracket-free literals; strip the WHATWG IPv6 brackets.
  const bareHost = normaliseIpLiteral(host);
  if (METADATA_HOSTS.has(host) || METADATA_HOSTS.has(bareHost)) {
    throw new EgressError(`blocked cloud-metadata endpoint: ${host}`);
  }
  if (isLocalHost(host)) {
    return; // local models are allowed regardless of allowRemote
  }
  // From here on the host is remote.
  if (!allowRemote) {
    throw new EgressError(
      `remote endpoint ${JSON.stringify(host)} blocked: enable allowRemote to use non-local models`,
    );
  }
  if (!allowlist.has(host)) {
    const sorted = [...allowlist].sort();
    throw new EgressError(
      `remote host ${JSON.stringify(host)} is not in the egress allowlist ${JSON.stringify(sorted)}`,
    );
  }
  // WHATWG URL.protocol carries a trailing colon, e.g. "https:".
  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'https') {
    throw new EgressError(
      `remote endpoint ${JSON.stringify(host)} must use https (got ${JSON.stringify(scheme)})`,
    );
  }
}

/**
 * Resolve a URL's hostname and re-classify every returned address so an allowlisted DNS
 * name that resolves to a private / link-local / metadata IP is blocked before the
 * request leaves (DNS-rebinding defence, audit F9). Literal IPs and localhost are already
 * fully classified by validateEgress, so they skip resolution.
 */
export async function assertResolvedHostSafe(rawUrl: string): Promise<void> {
  let host: string;
  try {
    host = (new URL(rawUrl).hostname || '').toLowerCase();
  } catch {
    return;
  }
  if (!host || host === 'localhost' || host === 'ip6-localhost') {
    return;
  }
  const lit = normaliseIpLiteral(host);
  if (net.isIP(lit) !== 0) {
    return; // a literal IP — validateEgress already classified it
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new EgressError(`could not resolve host ${JSON.stringify(host)} for the egress check`);
  }
  for (const a of addrs) {
    const ip = normaliseIpLiteral(a.address.toLowerCase());
    if (METADATA_HOSTS.has(ip) || isLocalHost(a.address)) {
      throw new EgressError(
        `host ${JSON.stringify(host)} resolves to a blocked address ${JSON.stringify(a.address)} (DNS-rebinding)`,
      );
    }
  }
}

/**
 * Wrap a FetchLike so every request URL's host is validated against the egress policy
 * (validateEgress) AND resolve-rechecked (assertResolvedHostSafe) before the underlying
 * fetch runs. Throws EgressError on a policy violation, never reaching the network.
 */
export function makeGuardedFetch(
  inner: FetchLike = httpFetch,
  allowRemote = false,
  allowlist: ReadonlySet<string> = DEFAULT_REMOTE_ALLOWLIST,
): FetchLike {
  const guarded = (async (
    input: Parameters<FetchLike>[0],
    init?: Parameters<FetchLike>[1],
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    validateEgress(url, allowRemote, allowlist);
    await assertResolvedHostSafe(url);
    return inner(input, init);
  }) as FetchLike;
  return guarded;
}

/** Convenience: lowercased hostname of a base URL (exported for downstream). */
export { hostOf };
