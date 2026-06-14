// HTTP helpers for the debate engine.
// Every networked client takes an optional FetchLike so tests can inject a fake.
// Timeouts use AbortController; errors carry status + a short response body.

/** Injectable fetch type. Matches the global `fetch` signature. */
export type FetchLike = typeof fetch;

/** Default fetch: delegates to the runtime global (Node 24 / browser). */
export const httpFetch: FetchLike = ((...a: Parameters<FetchLike>) =>
  (globalThis.fetch as FetchLike)(...a)) as FetchLike;

/** Max chars of an error response body to surface in the thrown message. */
const ERROR_BODY_LIMIT = 500;

/** Thrown on a non-2xx HTTP response; carries the numeric status so retry loops
 *  can distinguish 4xx (fail fast, like Python's raise_for_status) from 5xx. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, url: string, body: string) {
    super(`HTTP ${status} ${statusText} for ${url}: ${body}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Fetch JSON with an AbortController timeout.
 * Throws on a non-2xx response (status + short body) or on timeout/network error.
 * Resolves to the parsed JSON body on success.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 60000,
  fetchImpl: FetchLike = httpFetch,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '';
      }
      if (body.length > ERROR_BODY_LIMIT) {
        body = body.slice(0, ERROR_BODY_LIMIT);
      }
      throw new HttpError(res.status, res.statusText, url, body);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
