import {
  StorageAdapter, ConflictError, AuthError, NotFoundError,
  NetworkError, ensureHostPermission
} from './base.js';

/**
 * WebDAV over HTTPS. One adapter covers Nextcloud, ownCloud, Synology, Seafile
 * and any Apache with mod_dav, which is why it replaces the FTP option people
 * ask for — Firefox removed FTP entirely in version 90 and fetch() only speaks
 * http(s).
 *
 * Concurrency is optimistic: read gives an ETag, write sends If-Match, and a 412
 * means another computer got there first. Nextcloud runs sabre/dav, which
 * supports conditional requests, but this is worth verifying against an actual
 * instance before relying on it.
 */

export class WebdavAdapter extends StorageAdapter {
  /** @param {{serverUrl:string, folderPath:string, userId:string}} cfg
   *  @param {{user:string, secret:string}} credentials */
  constructor(cfg, credentials) {
    super();
    this.serverUrl = (cfg.serverUrl || '').replace(/\/+$/, '');
    this.folderPath = normaliseFolder(cfg.folderPath);
    this.userId = cfg.userId;
    // 'nextcloud' derives the DAV path from the account; 'generic' takes it
    // verbatim, because Synology, kDrive, Fastmail and a plain Apache mod_dav
    // each put their collection somewhere different.
    this.mode = cfg.mode === 'generic' ? 'generic' : 'nextcloud';
    this.davUrl = (cfg.davUrl || '').replace(/\/+$/, '');
    this.credentials = credentials;
    this.basePrepared = false;
    this.createOnlyUnsupported = false;
    this.ifMatchUnsupported = false;
    this.trace = [];
  }

  get capabilities() { return { history: true, maxBytes: null }; }

  /** The account's DAV collection, without the extension's own folder. */
  get davRoot() {
    return this.mode === 'generic'
      ? this.davUrl
      : `${this.serverUrl}/remote.php/dav/files/${encodeURIComponent(this.userId)}`;
  }

  get baseUrl() {
    return `${this.davRoot}${this.folderPath}`;
  }

  urlFor(key) {
    return `${this.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  get authHeader() {
    return 'Basic ' + btoa(`${this.credentials.user}:${this.credentials.secret}`);
  }

  async request(method, url, { headers = {}, body } = {}) {
    await ensureHostPermission(url);

    // Kept so a failing sync can be inspected as a sequence rather than as a
    // single error message. Two rounds of plausible theories turned out wrong;
    // the actual order of requests is the thing that settles it.
    const entry = {
      method,
      path: shortPath(url, this.baseUrl),
      ifMatch: headers['If-Match'] || null,
      ifNoneMatch: headers['If-None-Match'] || null
    };

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          // Belt and braces for intermediaries that ignore the fetch cache mode.
          'Cache-Control': 'no-cache',
          ...headers
        },
        body,
        // The extension supplies its own Authorization header; sending profile
        // cookies as well confuses servers behind SSO.
        credentials: 'omit',
        // Firefox's HTTP cache will happily serve a stored copy of a GET, ETag
        // and all. That turns a conditional write into a permanent 412 — the
        // If-Match carries the cached version while the server holds a newer
        // one — and, far worse, means the index is merged from stale data.
        // A GET and a HEAD returning different ETags for the same file is the
        // signature of it.
        cache: 'no-store'
      });
    } catch (e) {
      entry.status = 'ERR';
      entry.error = e.message;
      this.pushTrace(entry);
      throw new NetworkError(e.message);
    }

    entry.status = res.status;
    const rawEtag = res.headers.get('ETag');
    entry.etag = normaliseEtag(rawEtag);
    if (rawEtag && normaliseEtag(rawEtag) !== rawEtag.replace(/^W\//i, '').replace(/^"|"$/g, '')) {
      entry.rawEtag = rawEtag;
    }
    this.pushTrace(entry);

    if (res.status === 401 || res.status === 403) throw new AuthError(`HTTP ${res.status}`);
    return res;
  }

  pushTrace(entry) {
    this.trace.push(entry);
    if (this.trace.length > 60) this.trace.shift();
  }

  async test() {
    try {
      let res = await this.request('PROPFIND', this.baseUrl, { headers: { Depth: '0' } });

      // A path the user typed but has not created yet is the normal case, not
      // an error: build it and carry on.
      if (res.status === 404) {
        const created = await this.ensureFolderPath();
        res = await this.request('PROPFIND', this.baseUrl, { headers: { Depth: '0' } });
        if (res.status === 207 || res.ok) {
          return { ok: true, code: created ? 'okCreated' : 'ok' };
        }
        return { ok: false, code: 'notFound' };
      }

      if (!res.ok && res.status !== 207) {
        return { ok: false, code: 'generic', detail: `HTTP ${res.status}` };
      }

      const concurrency = await this.probeConcurrency();
      return { ok: true, code: concurrency, detail: this.probeDetail };
    } catch (e) {
      return { ok: false, code: mapErrorCode(e), detail: e.message };
    }
  }

  /**
   * Checks what the server actually does, rather than assuming.
   *
   * Everything that stops two computers overwriting each other rests on two
   * behaviours: the server returning an ETag, and honouring If-Match. A reverse
   * proxy can quietly strip the first, and not every WebDAV implementation does
   * the second — so this writes a scratch file, reads it back, and tries a
   * deliberately stale conditional write to see what happens.
   */
  async probeConcurrency() {
    const key = '.tgsr-probe.json';
    this.probeDetail = null;

    try {
      if (!this.basePrepared) await this.ensureFolderPath();
      // Padded so a compressing proxy treats it like a real file; a short body
      // slips under the compression threshold and hides ETag rewriting.
      const pad = 'x'.repeat(4096);
      await this.request('PUT', this.urlFor(key), {
        headers: { 'Content-Type': 'application/json' },
        body: `{"probe":1,"pad":"${pad}"}`
      });

      const get = await this.request('GET', this.urlFor(key));
      const etag = normaliseEtag(get.headers.get('ETag'));

      if (!etag) {
        this.probeDetail = 'no ETag header on GET';
        return 'okNoEtag';
      }

      // A correct If-Match must be accepted. When it is not, something between
      // here and the origin is rewriting the tag.
      const valid = await this.request('PUT', this.urlFor(key), {
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${etag}"` },
        body: `{"probe":2,"pad":"${pad}"}`
      });

      if (valid.status === 412) {
        this.probeDetail = `a valid If-Match was refused (ETag ${etag})`;
        return 'okBrokenEtag';
      }

      const afterValid = normaliseEtag(valid.headers.get('ETag'))
        || normaliseEtag((await this.request('GET', this.urlFor(key))).headers.get('ETag'));

      // A stale If-Match must be refused. If it is accepted, conditional writes
      // are decorative and simultaneous edits can silently overwrite.
      const stale = await this.request('PUT', this.urlFor(key), {
        headers: { 'Content-Type': 'application/json', 'If-Match': '"tgsr-definitely-stale"' },
        body: `{"probe":3,"pad":"${pad}"}`
      });

      if (stale.status !== 412) {
        this.probeDetail = `stale If-Match answered HTTP ${stale.status}, expected 412`;
        return 'okNoIfMatch';
      }

      if (!afterValid) {
        this.probeDetail = 'no ETag returned after a write';
        return 'okNoEtag';
      }

      return 'ok';
    } catch (e) {
      this.probeDetail = String(e.message || e);
      return 'ok';
    } finally {
      await this.request('DELETE', this.urlFor(key)).catch(() => {});
    }
  }

  /**
   * Creates every missing segment of folderPath, from the account root down.
   *
   * Order matters: MKCOL answers 409 when the parent is missing, so the chain
   * has to be walked top-down. 405 means the collection is already there, which
   * is the ordinary outcome for all but the last segment.
   *
   * @returns {Promise<boolean>} whether anything was actually created
   */
  async ensureFolderPath() {
    const segments = this.folderPath.split('/').filter(Boolean);
    if (!segments.length) return false;

    const root = this.davRoot;
    let created = false;
    let path = '';

    for (const segment of segments) {
      path += '/' + encodeURIComponent(segment);
      const res = await this.request('MKCOL', root + path);

      if (res.status === 405) continue;          // already exists
      if (res.ok || res.status === 201) { created = true; continue; }
      if (res.status === 409) throw new NotFoundError(path);
      throw new NetworkError(`MKCOL ${path}: HTTP ${res.status}`);
    }

    this.basePrepared = true;
    return created;
  }

  async read(key) {
    const res = await this.request('GET', this.urlFor(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
    return { data: await res.json(), etag: normaliseEtag(res.headers.get('ETag')) };
  }

  async write(key, data, etag) {
    // Done once per adapter instance: the first write after a fresh setup would
    // otherwise fail on a folder the user never created by hand.
    if (!this.basePrepared) await this.ensureFolderPath();
    await this.ensureParent(key);

    const headers = { 'Content-Type': 'application/json' };
    // If-None-Match: * means "only if it does not exist yet"; If-Match pins the
    // version we based our change on.
    if (etag === null && !this.createOnlyUnsupported) headers['If-None-Match'] = '*';
    else if (etag !== undefined && etag !== null && !this.ifMatchUnsupported) {
      headers['If-Match'] = `"${etag}"`;
    }

    const res = await this.request('PUT', this.urlFor(key), {
      headers,
      body: JSON.stringify(data)
    });

    if (res.status === 412) {
      // A 412 against If-None-Match: * is supposed to mean "it already exists".
      // Some servers answer it even for a file that is not there, which would
      // make the very first write on an empty folder fail forever. Check what
      // is actually true before believing the precondition.
      if (etag === null) {
        const head = await this.request('HEAD', this.urlFor(key));
        if (head.status === 404) {
          this.createOnlyUnsupported = true;
          return this.write(key, data, undefined);
        }
        throw new ConflictError(key);
      }

      // A 412 against If-Match should mean somebody else wrote in between. But
      // a reverse proxy that rewrites ETags — Apache's mod_deflate appends
      // "-gzip" when it compresses — makes the value we read back differ from
      // the one the origin stored, so a perfectly valid precondition is refused
      // every single time. Re-read before believing it: if the current tag is
      // still the one we sent, nothing changed and the precondition is what is
      // broken.
      if (typeof etag === 'string') {
        const head = await this.request('HEAD', this.urlFor(key));
        const current = normaliseEtag(head.headers.get('ETag'));

        if (current !== null && current === normaliseEtag(etag)) {
          this.ifMatchUnsupported = true;
          return this.write(key, data, undefined);
        }

        // The version we were given differs from the one the server reports on
        // a HEAD. Either somebody really did write in between — a genuine
        // conflict — or the GET came from a cache. The caller re-reads either
        // way, but the distinction belongs in the record.
        const err = new ConflictError(key);
        err.detail = `sent ${etag}, server has ${current}`;
        throw err;
      }

      throw new ConflictError(key);
    }
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);

    let newEtag = normaliseEtag(res.headers.get('ETag'));
    if (!newEtag) {
      // Some servers omit the ETag on PUT; a HEAD gets it back.
      const head = await this.request('HEAD', this.urlFor(key));
      newEtag = normaliseEtag(head.headers.get('ETag'));
    }
    return { etag: newEtag };
  }

  async list(prefix) {
    const url = `${this.baseUrl}/${prefix}`.replace(/\/+$/, '/');
    const res = await this.request('PROPFIND', url, { headers: { Depth: '1' } });
    if (res.status === 404) return [];
    if (res.status !== 207) throw new NetworkError(`HTTP ${res.status}`);

    return parsePropfind(await res.text(), this.basePathname())
      .filter((e) => !e.isCollection)
      .map((e) => ({ key: e.path, modifiedAt: e.modifiedAt }));
  }

  async remove(key) {
    const res = await this.request('DELETE', this.urlFor(key));
    if (!res.ok && res.status !== 404) throw new NetworkError(`HTTP ${res.status}`);
  }

  /**
   * Walks every conditional-write case in order and reports the raw status of
   * each, so a server that mishandles one of them is identified rather than
   * guessed at.
   */
  async diagnose() {
    const key = '.tgsr-diagnose.json';
    const url = this.urlFor(key);
    const steps = [];
    const record = async (label, method, headers, body) => {
      try {
        const res = await this.request(method, url, { headers, body });
        steps.push({ label, status: res.status, etag: normaliseEtag(res.headers.get('ETag')) });
        return res;
      } catch (e) {
        steps.push({ label, status: null, error: String(e.message || e) });
        return null;
      }
    };

    const json = { 'Content-Type': 'application/json' };

    try {
      if (!this.basePrepared) await this.ensureFolderPath();
      await this.request('DELETE', url).catch(() => {});

      // Large enough that a compressing proxy will actually compress it. A tiny
      // file stays below the threshold and hides exactly the problem this is
      // meant to find.
      const filler = 'x'.repeat(4096);

      steps.push({
        label: 'PROPFIND folder',
        status: (await this.request('PROPFIND', this.baseUrl, { headers: { Depth: '0' } })).status
      });
      await record('PUT new, If-None-Match:*  (expect 201)', 'PUT',
        { ...json, 'If-None-Match': '*' }, `{"n":1,"pad":"${filler}"}`);
      await record('PUT again, If-None-Match:*  (expect 412)', 'PUT',
        { ...json, 'If-None-Match': '*' }, `{"n":2,"pad":"${filler}"}`);

      const get = await record('GET  (expect 200 + ETag)', 'GET', {});
      const etag = get ? normaliseEtag(get.headers.get('ETag')) : null;

      if (etag) {
        await record('PUT with current If-Match  (expect 2xx)', 'PUT',
          { ...json, 'If-Match': `"${etag}"` }, `{"n":3,"pad":"${filler}"}`);
      }
      await record('PUT with stale If-Match  (expect 412)', 'PUT',
        { ...json, 'If-Match': '"tgsr-stale"' }, `{"n":4,"pad":"${filler}"}`);
      await record('PUT unconditional  (expect 2xx)', 'PUT', json,
        `{"n":5,"pad":"${filler}"}`);
    } finally {
      await this.request('DELETE', url).catch(() => {});
    }

    return steps;
  }

  /* ---------- folder handling ---------- */

  basePathname() {
    return new URL(this.baseUrl).pathname.replace(/\/+$/, '') + '/';
  }

  async ensureParent(key) {
    const parts = key.split('/');
    if (parts.length < 2) return;
    let path = '';
    for (const segment of parts.slice(0, -1)) {
      path += (path ? '/' : '') + segment;
      const res = await this.request('MKCOL', `${this.baseUrl}/${path}`);
      // 405 means it is already there, which is the normal case.
      if (!res.ok && res.status !== 405) {
        if (res.status === 409) throw new NotFoundError(path);
      }
    }
  }

  /** Used by the folder picker in Settings. */
  async listDirectories(absolutePath) {
    const url = `${this.davRoot}${absolutePath}`;
    const res = await this.request('PROPFIND', url, { headers: { Depth: '1' } });
    if (res.status !== 207) throw new NetworkError(`HTTP ${res.status}`);
    const base = new URL(url).pathname.replace(/\/+$/, '') + '/';
    return parsePropfind(await res.text(), base)
      .filter((e) => e.isCollection && e.path)
      .map((e) => e.path.replace(/\/$/, ''))
      // The server returns them in its own order. localeCompare sorts the way
      // the user expects: case-insensitive, accents in the right place, and
      // "Foto 2" before "Foto 10".
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  }

  /** Creates an arbitrary absolute path, parents included. */
  async createDirectory(absolutePath) {
    const root = this.davRoot;
    let path = '';
    for (const segment of absolutePath.split('/').filter(Boolean)) {
      path += '/' + encodeURIComponent(segment);
      const res = await this.request('MKCOL', root + path);
      if (res.status === 405 || res.ok || res.status === 201) continue;
      throw new NetworkError(`MKCOL ${path}: HTTP ${res.status}`);
    }
  }
}

/* ---------- Nextcloud Login Flow v2 ---------- */

/**
 * Never asks for the user's real password. Firefox opens the Nextcloud login
 * page, the user authorises (2FA and SSO work), and we poll until the server
 * hands back an app password the user can revoke from Settings > Security.
 *
 * Two documented constraints shape the code below: the token is valid for
 * twenty minutes, and the 200 is returned exactly once — lose that response and
 * the app password is gone, so it is persisted before anything else happens.
 */
export async function startLoginFlow(serverUrl) {
  const base = serverUrl.replace(/\/+$/, '');

  // Checked explicitly so a missing permission is reported as such instead of
  // surfacing later as an indistinguishable network failure.
  await ensureHostPermission(base);

  // Most installs answer on the first path; instances behind a reverse proxy
  // that hides index.php answer on the second.
  const candidates = [`${base}/index.php/login/v2`, `${base}/login/v2`];
  const failures = [];

  for (const url of candidates) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', credentials: 'omit' });
    } catch (e) {
      // fetch() collapses DNS failure, connection refused, an untrusted
      // certificate and a CORS block into one opaque TypeError, so the message
      // has to point at the whole set rather than pretend to know which.
      failures.push(`${url}: ${e.message}`);
      continue;
    }

    if (res.ok) {
      const body = await res.json();
      if (!body?.poll?.token || !body?.login) {
        throw new NetworkError(`unexpected response from ${url}`);
      }
      return {
        pollToken: body.poll.token,
        pollEndpoint: body.poll.endpoint,
        loginUrl: body.login
      };
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`HTTP ${res.status} at ${url}`);
    }
    failures.push(`${url}: HTTP ${res.status}`);
  }

  const err = new NetworkError(failures.join(' | '));
  err.code = 'unreachable';
  err.attempts = failures;
  throw err;
}

export async function pollLoginFlow({ pollEndpoint, pollToken }, { signal } = {}) {
  const deadline = Date.now() + 20 * 60 * 1000;   // matches the server's token lifetime

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted');

    const res = await fetch(pollEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(pollToken)}`,
      redirect: 'manual'
    });

    if (res.status === 200) {
      // { server, loginName, appPassword } — the only time we will ever see it.
      return res.json();
    }
    // 404, and on some instances 302, mean "not authorised yet".
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('login-flow-timeout');
}

/**
 * loginName can be an email or any other login identifier and does not
 * necessarily match the userid used to build the WebDAV path, so the real one
 * is read from the OCS endpoint.
 */
export async function fetchUserId(serverUrl, user, secret) {
  const base = serverUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/ocs/v1.php/cloud/user?format=json`, {
    headers: {
      Authorization: 'Basic ' + btoa(`${user}:${secret}`),
      'OCS-APIRequest': 'true',
      Accept: 'application/json'
    },
    credentials: 'omit'
  });
  if (res.status === 401) throw new AuthError('HTTP 401');
  if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);

  const body = await res.json();
  return body?.ocs?.data?.id || user;
}

/* ---------- helpers ---------- */

function shortPath(url, baseUrl) {
  try {
    return decodeURIComponent(url.replace(baseUrl, '')) || '/';
  } catch {
    return url;
  }
}

function normaliseFolder(path) {
  if (!path) return '';
  const p = path.startsWith('/') ? path : '/' + path;
  return p.replace(/\/+$/, '');
}

/**
 * A content-coding suffix appended by whatever compressed the response.
 *
 * Apache's mod_deflate appends "-gzip" to the ETag of anything it compresses,
 * and other proxies do the same with their own name. The origin never stores
 * it, so an If-Match built from a compressed GET carries a value the server has
 * never seen and is refused with 412 — every single time, on one computer.
 *
 * It only shows up on responses large enough to be worth compressing, which is
 * why a small probe file makes the server look perfectly healthy.
 */
const CONTENT_CODING_SUFFIX = /-(gzip|br|deflate|compress|zstd|identity)$/i;

function normaliseEtag(raw) {
  if (!raw) return null;
  const bare = raw.replace(/^W\//i, '').replace(/^"|"$/g, '');
  return bare.replace(CONTENT_CODING_SUFFIX, '');
}

function parsePropfind(xml, basePath) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const responses = doc.getElementsByTagNameNS('DAV:', 'response');
  const out = [];

  for (const node of responses) {
    const hrefNode = node.getElementsByTagNameNS('DAV:', 'href')[0];
    if (!hrefNode) continue;

    const href = decodeURIComponent(hrefNode.textContent);
    if (!href.startsWith(basePath)) continue;

    const path = href.slice(basePath.length);
    if (!path) continue;   // the collection itself

    const isCollection =
      node.getElementsByTagNameNS('DAV:', 'collection').length > 0;
    const modNode = node.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];

    out.push({
      path,
      isCollection,
      modifiedAt: modNode ? Date.parse(modNode.textContent) : null
    });
  }
  return out;
}

function mapErrorCode(e) {
  if (e.name === 'AuthError') return 'auth';
  if (e.name === 'PermissionError') return 'permission';
  if (e.name === 'NetworkError') return 'network';
  if (e.name === 'NotFoundError') return 'notFound';
  return 'generic';
}
