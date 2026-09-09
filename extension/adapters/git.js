import {
  StorageAdapter, ConflictError, AuthError, NetworkError, ensureHostPermission
} from './base.js';

/**
 * GitHub, Gitea and Forgejo share the same Contents API, so one adapter with a
 * configurable base URL covers all three.
 *
 * The blob SHA plays the part of the ETag: the API requires it on update and
 * rejects a stale one, which gives real optimistic concurrency for free. The
 * host also keeps its own commit history, which is a pleasant bonus on top of
 * the extension's own snapshots.
 */
export class GitAdapter extends StorageAdapter {
  /** @param {{baseUrl:string, repo:string, branch:string, path:string}} cfg */
  constructor(cfg, credentials) {
    super();
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.repo = cfg.repo;                       // "owner/name"
    this.branch = cfg.branch || 'main';
    this.root = (cfg.path || '').replace(/^\/+|\/+$/g, '');
    this.token = credentials?.secret || null;
  }

  get capabilities() { return { history: true, maxBytes: null }; }

  pathFor(key) {
    return this.root ? `${this.root}/${key}` : key;
  }

  contentsUrl(key) {
    return `${this.baseUrl}/repos/${this.repo}/contents/${this.pathFor(key)}`;
  }

  async request(method, url, body) {
    await ensureHostPermission(url);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (e) {
      throw new NetworkError(e.message);
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`HTTP ${res.status}`);
    return res;
  }

  async test() {
    if (!this.token) return { ok: false, code: 'noCredentials' };
    try {
      const res = await this.request('GET', `${this.baseUrl}/repos/${this.repo}`);
      if (res.status === 404) return { ok: false, code: 'notFound' };
      if (!res.ok) return { ok: false, code: 'generic', detail: `HTTP ${res.status}` };
      const repo = await res.json();
      if (!repo.private) {
        // Worth saying out loud: a public repo means anyone can read the file,
        // and only the master password stands between them and the tab list.
        return { ok: true, code: 'okPublicRepo' };
      }
      return { ok: true, code: 'ok' };
    } catch (e) {
      return { ok: false, code: e.name === 'AuthError' ? 'auth' : 'network', detail: e.message };
    }
  }

  async read(key) {
    const url = `${this.contentsUrl(key)}?ref=${encodeURIComponent(this.branch)}`;
    const res = await this.request('GET', url);
    if (res.status === 404) return null;
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);

    const file = await res.json();
    const json = new TextDecoder().decode(base64ToBytes(file.content.replace(/\n/g, '')));
    return { data: JSON.parse(json), etag: file.sha };
  }

  async write(key, data, etag) {
    const body = {
      message: `tgsr: update ${key}`,
      content: bytesToBase64(new TextEncoder().encode(JSON.stringify(data, null, 0))),
      branch: this.branch
    };
    // The API refuses an update without the current sha, and refuses a stale
    // one with 409 — exactly the semantics we want.
    if (etag) body.sha = etag;

    const res = await this.request('PUT', this.contentsUrl(key), body);
    if (res.status === 409 || res.status === 422) throw new ConflictError(key);
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);

    const out = await res.json();
    return { etag: out.content?.sha || null };
  }

  async list(prefix) {
    const dir = this.pathFor(prefix).replace(/\/+$/, '');
    const url = `${this.baseUrl}/repos/${this.repo}/contents/${dir}?ref=${encodeURIComponent(this.branch)}`;
    const res = await this.request('GET', url);
    if (res.status === 404) return [];
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);

    const entries = await res.json();
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => e.type === 'file')
      .map((e) => ({ key: `${prefix}${e.name}`, modifiedAt: null }));
  }

  async remove(key) {
    const current = await this.read(key);
    if (!current) return;
    const res = await this.request('DELETE', this.contentsUrl(key), {
      message: `tgsr: remove ${key}`,
      sha: current.etag,
      branch: this.branch
    });
    if (!res.ok && res.status !== 404) throw new NetworkError(`HTTP ${res.status}`);
  }
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
