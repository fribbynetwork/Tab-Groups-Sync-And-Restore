import { normaliseDeviceName, sessionSignature } from '../lib/schema.js';
import { LockedError, WrongPassphraseError, canOpen } from '../lib/crypto.js';
import {
  getPrefs, getLocal, setLocal, isConfigured, backendState, setBackendState
} from '../lib/config.js';
import { createAdapter, ConflictError } from '../adapters/index.js';
import { keyStatus } from './keyflow.js';
import { captureAll } from './capture.js';
import { applyGroups, closeGroups } from './restore.js';
import { saveSnapshot } from './history.js';
import {
  writeDeviceFile, readDeviceFile, groupsOf, listDevices
} from './device-file.js';

/**
 * The whole engine, now that each computer owns one file.
 *
 * Publishing is a plain write: no index, no preconditions, no merge. Nobody
 * else writes this file, so there is nothing to reconcile and a group that was
 * closed simply stops appearing.
 *
 * Receiving is a comparison of timestamps: a device whose file is newer than
 * the last one this computer acknowledged is offered to the user, who decides.
 * Nothing is ever applied on its own.
 */

let currentAdapter = null;
let notes = [];
let queue = Promise.resolve();
let publishQueued = false;

/** Backend work runs one at a time; overlapping runs caused their own bugs. */
function exclusive(label, fn) {
  const run = queue.then(() => withTrace(label, fn), () => withTrace(label, fn));
  queue = run.then(() => {}, () => {});
  return run;
}

async function withTrace(label, fn) {
  currentAdapter = null;
  notes = [];
  note(`operation: ${label}`);
  try {
    return await fn();
  } catch (e) {
    const prefs = await getPrefs();
    await setBackendState(prefs.backend, {
      lastError: describeError(e),
      lastErrorAt: Date.now(),
      lastTrace: buildTrace()
    }).catch(() => {});
    throw e;
  }
}

export function note(text) {
  notes.push({ note: text });
}

function buildTrace() {
  const requests = currentAdapter?.trace ? currentAdapter.trace.slice(-40) : [];
  return [...notes, ...requests];
}

/* ---------- publishing this computer's session ---------- */

export async function runSync({ force = false } = {}) {
  if (!(await isConfigured())) return { skipped: 'not-configured' };

  const local = await getLocal();
  if (!local.setupDone) return { skipped: 'setup-incomplete' };
  if (!local.deviceName) return { skipped: 'no-device-name' };

  const key = await keyStatus().catch(() => ({ state: 'off' }));
  if (key.state === 'locked') {
    const prefs = await getPrefs();
    await setBackendState(prefs.backend, {
      lastError: { code: key.mismatch ? 'passwordChanged' : 'locked' },
      lastErrorAt: Date.now()
    });
    return { skipped: 'locked' };
  }

  if (publishQueued && !force) return { skipped: 'already-queued' };
  publishQueued = true;

  return exclusive('publish', async () => {
    publishQueued = false;
    return publishNow(force);
  });
}

async function publishNow(force) {
  const prefs = await getPrefs();
  const local = await getLocal();
  const adapter = await createAdapter(prefs, local);
  currentAdapter = adapter;

  const state = backendState(local, prefs.backend);
  const groups = await captureAll();
  const signature = sessionSignature(groups);

  note(`publish ${local.deviceName}: ${groups.length} groups, sig ${signature}`);

  if (!force && signature === state.lastSignature) {
    note('unchanged since the last write, nothing to do');
    await setBackendState(prefs.backend, { lastSyncAt: Date.now(), lastError: null });
    return { written: false, groups: groups.length };
  }

  // Whether this file is encrypted follows whatever is already on the server,
  // so one computer turning encryption off does not leave the others writing
  // files it can no longer read.
  const encrypted = await encryptionInUse(adapter, prefs, local);

  await writeDeviceFile(adapter, local.deviceName, groups, {
    encrypted,
    installId: local.installId
  });

  await saveSnapshot(adapter, local.deviceName, groups).catch(() => {});

  await setBackendState(prefs.backend, {
    lastSyncAt: Date.now(),
    lastSignature: signature,
    lastError: null,
    lastErrorAt: null,
    lastTrace: null
  });

  return { written: true, groups: groups.length };
}

async function encryptionInUse(adapter, prefs, local) {
  const mine = await readDeviceFile(adapter, local.deviceName).catch(() => null);
  if (mine) return mine.enc === 'AES-GCM';

  const others = await listDevices(adapter, { selfName: local.deviceName })
    .catch(() => []);
  const other = others.find((d) => !d.self);
  if (other) return other.encrypted;

  return prefs.encryption.enabled;
}

/* ---------- noticing what the other computers did ---------- */

/**
 * A device counts as changed when its file is newer than the timestamp this
 * computer last acknowledged. Acknowledging is explicit — including through
 * "do nothing" — so the same change is never offered twice.
 */
export async function checkOthers() {
  if (!(await isConfigured())) return { changed: [] };
  return exclusive('check', checkOthersNow);
}

async function checkOthersNow() {
  const prefs = await getPrefs();
  const local = await getLocal();
  const adapter = await createAdapter(prefs, local);
  currentAdapter = adapter;

  const state = backendState(local, prefs.backend);
  const seen = state.seenDevices || {};

  const devices = await listDevices(adapter, { selfName: local.deviceName });

  // Whether a file opens is settled by trying to open it, not by comparing key
  // ids. The verifier in its header is a few bytes sealed with the same key, so
  // the test costs nothing and cannot be wrong.
  const unreadable = [];
  for (const d of devices) {
    if (d.self || !d.encrypted) continue;
    if (!(await canOpen(d.envelope))) unreadable.push(d.name);
  }

  const changed = devices
    .filter((d) => !d.self && !unreadable.includes(d.name) && d.updatedAt > (seen[d.name] || 0))
    .map((d) => ({ name: d.name, updatedAt: d.updatedAt, encrypted: d.encrypted }));

  note(`check: ${devices.length} devices, ${changed.length} changed, ${unreadable.length} unreadable`);

  await setBackendState(prefs.backend, { unreadableDevices: unreadable });

  await setBackendState(prefs.backend, { pendingDevices: changed });
  return { changed, devices, unreadable };
}

/* ---------- acting on one of them ---------- */

/** Opens another computer's groups alongside the ones already here. */
export async function openFrom(deviceName) {
  return exclusive('open-from', () => applyFrom(deviceName, { replace: false }));
}

/** Closes this computer's groups and puts that computer's in their place. */
export async function replaceWith(deviceName) {
  return exclusive('replace-with', () => applyFrom(deviceName, { replace: true }));
}

async function applyFrom(deviceName, { replace }) {
  const prefs = await getPrefs();
  const local = await getLocal();
  const adapter = await createAdapter(prefs, local);
  currentAdapter = adapter;

  const file = await readDeviceFile(adapter, deviceName);
  if (!file) return { opened: 0, closed: 0 };

  const incoming = await groupsOf(file);
  note(`${replace ? 'replace with' : 'open from'} ${deviceName}: ${incoming.length} groups`);

  let closed = 0;
  if (replace) {
    const here = await captureAll();
    // The safety net first: the previous session becomes a snapshot before
    // anything is closed, so this is recoverable from history.
    await saveSnapshot(adapter, local.deviceName, here).catch(() => {});
    closed = await closeGroups(here.map((g) => g.uuid));
    note(`closed ${closed} local groups`);
  }

  const opened = await applyGroups(incoming);
  note(`opened ${opened.length}`);

  await acknowledge(deviceName, file.updatedAt);

  // The groups are ours now, so the next write includes them. Forced, because
  // after a replace the signature may match an earlier one.
  await setBackendState(prefs.backend, { lastSignature: null });

  return { opened: opened.length, closed };
}

/** Dismisses a change without applying it. */
export async function ignoreFrom(deviceName) {
  return exclusive('ignore', async () => {
    const prefs = await getPrefs();
    const local = await getLocal();
    const adapter = await createAdapter(prefs, local);
    const file = await readDeviceFile(adapter, deviceName).catch(() => null);
    await acknowledge(deviceName, file?.updatedAt || Date.now());
    return { ignored: deviceName };
  });
}

async function acknowledge(deviceName, updatedAt) {
  const prefs = await getPrefs();
  const local = await getLocal();
  const state = backendState(local, prefs.backend);

  await setBackendState(prefs.backend, {
    seenDevices: { ...state.seenDevices, [deviceName]: updatedAt },
    pendingDevices: (state.pendingDevices || []).filter((d) => d.name !== deviceName)
  });
}

/* ---------- the device name ---------- */

/**
 * Claiming a name is the one place a collision can happen, so it is checked
 * once, here, rather than guarded on every write.
 */
export async function checkDeviceName(rawName) {
  const name = normaliseDeviceName(rawName);
  if (!name) return { name, status: 'invalid' };
  if (!(await isConfigured())) return { name, status: 'free' };

  const local = await getLocal();
  const adapter = await createAdapter();
  const existing = await readDeviceFile(adapter, name).catch(() => null);

  if (!existing) return { name, status: 'free' };
  if (existing.installId === local.installId) return { name, status: 'mine' };

  return {
    name,
    status: 'taken',
    updatedAt: existing.updatedAt,
    encrypted: existing.enc === 'AES-GCM'
  };
}

/**
 * Renaming moves the file rather than abandoning it: the old name would
 * otherwise linger on the server as a device that no longer exists.
 */
export async function renameDevice(rawName) {
  const name = normaliseDeviceName(rawName);
  return exclusive('rename', async () => {
    const prefs = await getPrefs();
    const local = await getLocal();
    const previous = local.deviceName;

    await setLocal({ deviceName: name });

    if (!previous || previous === name || !(await isConfigured())) return { name };

    const adapter = await createAdapter(prefs, { ...local, deviceName: name });
    const old = await readDeviceFile(adapter, previous).catch(() => null);

    if (old) {
      const groups = await groupsOf(old).catch(() => []);
      await writeDeviceFile(adapter, name, groups, {
        encrypted: old.enc === 'AES-GCM',
        installId: local.installId
      });
      await adapter.remove(`${previous}.json`).catch(() => {});
      await moveHistory(adapter, previous, name);
    }

    note(`renamed ${previous} -> ${name}`);
    return { name, previous };
  });
}

async function moveHistory(adapter, from, to) {
  const entries = await adapter.list(`history/${from}/`).catch(() => []);
  for (const entry of entries) {
    const file = await adapter.read(entry.key).catch(() => null);
    if (!file) continue;
    await adapter.write(entry.key.replace(`history/${from}/`, `history/${to}/`), file.data, null)
      .catch(() => {});
    await adapter.remove(entry.key).catch(() => {});
  }
}

/* ---------- errors ---------- */

function describeError(e) {
  if (e instanceof ConflictError) return { code: 'conflict', detail: e.detail || e.message };
  if (e instanceof LockedError) return { code: 'locked' };
  if (e instanceof WrongPassphraseError) return { code: 'wrongPassphrase' };
  if (e.name === 'AuthError') return { code: 'auth', detail: e.message };
  if (e.name === 'NetworkError') return { code: 'network' };
  if (e.name === 'QuotaError') return { code: 'quota', bytes: e.bytes, limit: e.limit };
  if (e.name === 'PermissionError') return { code: 'permission' };
  return { code: 'generic', detail: String(e.message || e) };
}
