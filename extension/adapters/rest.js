import {
  StorageAdapter, ConflictError, AuthError, NetworkError, ensureHostPermission
} from './base.js';

/**
 * A tiny JSON API the user hosts themselves. The contract is deliberately small
 * enough to implement in about forty lines of PHP:
 *
 *   GET    {endpoint}/{key}   -> 200 with the JSON body and an ETag header,
 *                                or 404
 *   PUT    {endpoint}/{key}   -> 200 with a new ETag; 412 if If-Match does not
 *                                match the stored version
 *   DELETE {endpoint}/{key}   -> 200 or 404
 *   GET    {endpoint}?list={prefix}
 *                             -> 200 with [{ key, modifiedAt }]
 *
 * Authorization: Bearer <token> on every request.
 */
export class RestAdapter extends StorageAdapter {
  constructor(cfg, credentials) {
    super();
    this.endpoint = cfg.endpointUrl.replace(/\/+$/, '');
    this.token = credentials?.secret || null;
  }

  get capabilities() { return { history: true, maxBytes: null }; }

  get headers() {
    const h = { Accept: 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(method, url, { headers = {}, body } = {}) {
    await ensureHostPermission(url);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Cache-Control': 'no-cache', ...this.headers, ...headers },
        body,
        credentials: 'omit',
        // A cached GET would hand back an old ETag and an old body; see webdav.js.
        cache: 'no-store'
      });
    } catch (e) {
      throw new NetworkError(e.message);
    }
    if (res.status === 401 || res.status === 403) {
      // The body carries the reason when the endpoint bothers to give one, and
      // "the header never arrived" and "the token is wrong" are very different
      // problems that otherwise look identical.
      const body = summariseErrorBody(await res.clone().text().catch(() => ''));
      throw new AuthError(`HTTP ${res.status}${body ? ` — ${body}` : ''}`);
    }
    return res;
  }

  /**
   * Walks the whole contract and reports what was sent and what came back.
   *
   * The Authorization header is shown by length and last characters only: it is
   * enough to spot an empty, truncated or stale token without putting the
   * credential itself on screen.
   */
  async diagnose() {
    const key = '.tgsr-diagnose.json';
    const fileUrl = `${this.endpoint}/${key}`;
    const steps = [];

    steps.push({
      label: 'Authorization header sent',
      status: this.token ? 'OK' : 'NONE',
      detail: this.token
        ? `Bearer …${this.token.slice(-4)} (${this.token.length} characters)`
        : 'no token configured for this destination'
    });
    steps.push({ label: 'Endpoint', status: '', detail: this.endpoint });

    const record = async (label, method, url, headers, body) => {
      try {
        await ensureHostPermission(url);
        const res = await fetch(url, {
          method,
          headers: { ...this.headers, ...headers },
          body,
          credentials: 'omit'
        });
        const text = await res.text().catch(() => '');
        steps.push({
          label,
          status: res.status,
          etag: stripQuotes(res.headers.get('ETag')),
          detail: res.ok
            ? (label.includes('selftest') ? text.replace(/\s+/g, ' ').slice(0, 400) : undefined)
            : summariseErrorBody(text)
        });
        return res;
      } catch (e) {
        steps.push({ label, status: 'ERR', detail: String(e.message || e) });
        return null;
      }
    };

    const json = { 'Content-Type': 'application/json' };
    const pad = 'x'.repeat(4096);

    await record('GET ?selftest  (expect 200)', 'GET', `${this.endpoint}?selftest=1`, {});
    await record('GET ?list=  (expect 200)', 'GET', `${this.endpoint}?list=`, {});
    await record('DELETE leftover probe', 'DELETE', fileUrl, {});
    await record('PUT new, If-None-Match:*  (expect 2xx)', 'PUT', fileUrl,
      { ...json, 'If-None-Match': '*' }, `{"n":1,"pad":"${pad}"}`);
    await record('PUT again, If-None-Match:*  (expect 412)', 'PUT', fileUrl,
      { ...json, 'If-None-Match': '*' }, `{"n":2,"pad":"${pad}"}`);

    const get = await record('GET probe  (expect 200 + ETag)', 'GET', fileUrl, {});
    const etag = get ? stripQuotes(get.headers.get('ETag')) : null;

    if (etag) {
      await record('PUT with current If-Match  (expect 2xx)', 'PUT', fileUrl,
        { ...json, 'If-Match': `"${etag}"` }, `{"n":3,"pad":"${pad}"}`);
    }
    await record('PUT with stale If-Match  (expect 412)', 'PUT', fileUrl,
      { ...json, 'If-Match': '"tgsr-stale"' }, `{"n":4,"pad":"${pad}"}`);
    await record('PUT unconditional  (expect 2xx)', 'PUT', fileUrl, json,
      `{"n":5,"pad":"${pad}"}`);
    await record('DELETE probe  (expect 200)', 'DELETE', fileUrl, {});

    return steps;
  }

  async test() {
    if (!this.token) return { ok: false, code: 'noCredentials' };
    try {
      const res = await this.request('GET', `${this.endpoint}?list=`);
      if (!res.ok) return { ok: false, code: 'generic', detail: `HTTP ${res.status}` };
      return { ok: true, code: 'ok' };
    } catch (e) {
      return { ok: false, code: e.name === 'AuthError' ? 'auth' : 'network', detail: e.message };
    }
  }

  async read(key) {
    const res = await this.request('GET', `${this.endpoint}/${key}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
    return { data: await res.json(), etag: stripQuotes(res.headers.get('ETag')) };
  }

  async write(key, data, etag) {
    const headers = { 'Content-Type': 'application/json' };
    if (etag === null) headers['If-None-Match'] = '*';
    else if (etag !== undefined) headers['If-Match'] = `"${etag}"`;

    const res = await this.request('PUT', `${this.endpoint}/${key}`, {
      headers, body: JSON.stringify(data)
    });
    if (res.status === 412) throw new ConflictError(key);
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
    return { etag: stripQuotes(res.headers.get('ETag')) };
  }

  async list(prefix) {
    const res = await this.request('GET', `${this.endpoint}?list=${encodeURIComponent(prefix)}`);
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
    return res.json();
  }

  async remove(key) {
    const res = await this.request('DELETE', `${this.endpoint}/${key}`);
    if (!res.ok && res.status !== 404) throw new NetworkError(`HTTP ${res.status}`);
  }
}

/**
 * Server error bodies come in two shapes: a JSON object the endpoint wrote on
 * purpose, and an HTML page the web server produced because the request never
 * reached the endpoint at all. The second one matters just as much — it means
 * the URL is misrouted — but only its title carries information.
 */
export function summariseErrorBody(text) {
  if (!text) return undefined;
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed.slice(0, 400);
  }

  const title = /<title>([^<]+)<\/title>/i.exec(trimmed);
  if (title) {
    return `${title[1].trim()} — served by the web server, not by the endpoint: `
         + 'the request never reached the script.';
  }
  return trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function stripQuotes(v) {
  return v ? v.replace(/^W\//, '').replace(/^"|"$/g, '') : null;
}
