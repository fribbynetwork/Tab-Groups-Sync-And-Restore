/**
 * Every backend implements this interface. The sync engine never knows which
 * one it is talking to.
 *
 *   test()                  -> { ok, code, detail }
 *   read(key)               -> { data, etag } | null
 *   write(key, data, etag)  -> { etag }        throws ConflictError on mismatch
 *   list(prefix)            -> [{ key, modifiedAt }]
 *   remove(key)             -> void
 *
 * `etag` gives optimistic concurrency: write() with the etag you read, and if
 * another computer wrote in between the call fails and the engine re-reads,
 * merges and retries. That is what keeps two machines from silently clobbering
 * each other, and it is why every adapter has to produce an etag even when the
 * underlying store has no such concept.
 *
 * The etag argument to write() has THREE distinct states, and conflating any two
 * of them causes conflicts out of nowhere:
 *
 *   string     write only if the stored version still matches  (If-Match)
 *   null       write only if nothing is there yet              (If-None-Match: *)
 *   undefined  write unconditionally
 *
 * The last one exists because a server may simply not return an ETag — behind a
 * reverse proxy that strips it, for instance. "I do not know the version" is not
 * the same as "this file must not exist", and treating it as such makes every
 * update fail with 412 even on a single computer.
 */

export class ConflictError extends Error {
  constructor(key) { super(`conflict: ${key}`); this.name = 'ConflictError'; }
}

export class AuthError extends Error {
  constructor(detail) { super(detail || 'auth'); this.name = 'AuthError'; }
}

export class NotFoundError extends Error {
  constructor(key) { super(`not found: ${key}`); this.name = 'NotFoundError'; }
}

export class NetworkError extends Error {
  constructor(detail) { super(detail || 'network'); this.name = 'NetworkError'; }
}

export class PermissionError extends Error {
  constructor(origin) { super(`no host permission: ${origin}`); this.name = 'PermissionError'; }
}

export class StorageAdapter {
  get capabilities() { return { history: false, maxBytes: null }; }
  async test() { throw new Error('not implemented'); }
  async read() { throw new Error('not implemented'); }
  async write() { throw new Error('not implemented'); }
  async list() { throw new Error('not implemented'); }
  async remove() { throw new Error('not implemented'); }
}

/** Weak etag for stores with no native versioning (storage.sync, some REST). */
export async function contentEtag(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Builds the match pattern for a host permission.
 *
 * Match patterns must not contain a port: the host component is the bare
 * hostname, and the pattern then covers every port on that host. Using
 * URL.origin here is wrong, because it keeps the port — and a pattern like
 * "https://example.com:49001/*" is accepted by permissions.contains while the
 * network layer refuses to honour it, so requests are silently blocked by CORS
 * and surface as an opaque NetworkError.
 */
export function originPatternFor(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`unsupported scheme: ${parsed.protocol}`);
  }
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/**
 * Checks only — never requests.
 *
 * Firefox requires permissions.request() to be called synchronously from a user
 * input handler, and any await beforehand loses the gesture. Adapters run from
 * the background, where there is no gesture at all, so they can only verify and
 * report. Asking is the UI's job; see requestHostPermission below.
 */
export async function ensureHostPermission(url) {
  const origin = originPatternFor(url);
  const has = await browser.permissions.contains({ origins: [origin] });
  if (!has) throw new PermissionError(origin);
  return true;
}

/**
 * For use in a click handler, and it must be the first thing that handler does:
 * no await may come before it. Returns a promise, so callers chain with .then()
 * rather than awaiting anything first.
 *
 * Calling it when the permission is already granted resolves true without
 * prompting, so it is safe to call on every attempt.
 */
export function requestHostPermission(url) {
  let origin;
  try {
    origin = originPatternFor(url);
  } catch {
    return Promise.resolve(false);
  }
  return browser.permissions.request({ origins: [origin] });
}
