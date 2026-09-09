import { StorageAdapter, ConflictError, contentEtag } from './base.js';

/**
 * The zero-setup tier, backed by the user's Mozilla account.
 *
 * Firefox enforces 102400 bytes in total, 8192 per item and 512 items. One file
 * per computer would otherwise mean a whole session in a single 8 KB item,
 * which a few dozen tabs exceed easily, so a file is split across as many items
 * as it needs and reassembled on read. The layout above stays unaware of it.
 *
 * Two limits worth knowing, neither of which this code can lift: the extension
 * needs a fixed ID (it has one), and the user must have "Add-ons" ticked under
 * Sync in about:preferences or nothing leaves the machine.
 */

const PREFIX = 'tgsr:';
const QUOTA_BYTES = 102400;
const QUOTA_BYTES_PER_ITEM = 8192;

// Room for the key, the JSON wrapper and the chunk index.
const ITEM_OVERHEAD = 96;

/**
 * Splits text into pieces that survive being stored as JSON strings.
 *
 * A fixed character count is not enough: JSON escaping doubles every quote, and
 * these chunks are themselves JSON, so a 7000-character slice serialises to
 * well over 8000 and the write fails on a limit it appeared to respect. Each
 * piece is measured as it will actually be stored.
 */
function splitToFit(text, budget) {
  const chunks = [];
  let at = 0;

  while (at < text.length) {
    // Start from the optimistic length and shrink until it really fits.
    let take = Math.min(budget, text.length - at);
    while (take > 1 && JSON.stringify(text.slice(at, at + take)).length > budget) {
      take = Math.floor(take * 0.9);
    }
    chunks.push(text.slice(at, at + take));
    at += take;
  }
  return chunks;
}

export class BrowserSyncAdapter extends StorageAdapter {
  get capabilities() {
    return { history: false, maxBytes: QUOTA_BYTES, maxItemBytes: QUOTA_BYTES_PER_ITEM };
  }

  async test() {
    try {
      const used = await browser.storage.sync.getBytesInUse(null);
      return {
        ok: true,
        code: 'ok',
        detail: `${Math.round(used / 1024)} KB / ${Math.round(QUOTA_BYTES / 1024)} KB`
      };
    } catch (e) {
      return { ok: false, code: 'generic', detail: e.message };
    }
  }

  async read(key) {
    const head = (await browser.storage.sync.get(PREFIX + key))[PREFIX + key];
    if (!head) return null;

    if (!head.chunks) return { data: head.data, etag: head.etag };

    const names = [];
    for (let i = 0; i < head.chunks; i++) names.push(`${PREFIX}${key}#${i}`);

    const parts = await browser.storage.sync.get(names);
    let text = '';
    for (const name of names) {
      // A missing chunk means a half-written file; better to report nothing
      // than to hand back a truncated session.
      if (parts[name] === undefined) return null;
      text += parts[name];
    }

    try {
      return { data: JSON.parse(text), etag: head.etag };
    } catch {
      return null;
    }
  }

  async write(key, data, etag) {
    const existing = (await browser.storage.sync.get(PREFIX + key))[PREFIX + key];

    if (etag === null && existing) throw new ConflictError(key);
    if (typeof etag === 'string' && existing && existing.etag !== etag) {
      throw new ConflictError(key);
    }

    const nextEtag = await contentEtag(data);
    const text = JSON.stringify(data);

    // Anything that fits stays a single item, which keeps the common case cheap.
    if (text.length + key.length + 64 <= QUOTA_BYTES_PER_ITEM) {
      await this.clearChunks(key, existing);
      await this.put({ [PREFIX + key]: { data, etag: nextEtag } }, key);
      return { etag: nextEtag };
    }

    const chunks = splitToFit(text, QUOTA_BYTES_PER_ITEM - key.length - ITEM_OVERHEAD);

    const items = {};
    chunks.forEach((chunk, i) => { items[`${PREFIX}${key}#${i}`] = chunk; });

    // Chunks first, header last: an interrupted write leaves the old header
    // pointing at the old chunks rather than a header pointing at nothing.
    await this.put(items, key);
    await this.clearChunks(key, existing, chunks.length);
    await this.put({ [PREFIX + key]: { chunks: chunks.length, etag: nextEtag } }, key);

    return { etag: nextEtag };
  }

  async put(items, key) {
    try {
      await browser.storage.sync.set(items);
    } catch (e) {
      // The quota message from Firefox names neither the extension's own
      // limits nor what to do, so it is translated into something actionable.
      const used = await browser.storage.sync.getBytesInUse(null).catch(() => null);
      const err = new Error('quota');
      err.name = 'QuotaError';
      err.bytes = used;
      err.limit = QUOTA_BYTES;
      err.key = key;
      err.detail = e.message;
      throw err;
    }
  }

  async clearChunks(key, existing, keep = 0) {
    if (!existing?.chunks) return;
    const stale = [];
    for (let i = keep; i < existing.chunks; i++) stale.push(`${PREFIX}${key}#${i}`);
    if (stale.length) await browser.storage.sync.remove(stale);
  }

  async list(prefix) {
    const all = await browser.storage.sync.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(PREFIX + prefix))
      // Chunks are an implementation detail; only whole files are listed.
      .filter((k) => !k.includes('#'))
      .map((k) => ({ key: k.slice(PREFIX.length), modifiedAt: null }));
  }

  async remove(key) {
    const existing = (await browser.storage.sync.get(PREFIX + key))[PREFIX + key];
    await this.clearChunks(key, existing);
    await browser.storage.sync.remove(PREFIX + key);
  }

  async bytesInUse() {
    return browser.storage.sync.getBytesInUse(null);
  }
}
