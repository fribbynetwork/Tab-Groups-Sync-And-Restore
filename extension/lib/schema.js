/**
 * Data schema, version 2.
 *
 * One file per computer, named after it:
 *
 *   ComputerCasa.json                 that computer's groups, and nothing else
 *   history/ComputerCasa/<ts>.json    its snapshots
 *
 * Version 1 kept a single shared index that every machine wrote to, with
 * tombstones and a three-way merge to reconcile them. Nearly every hard bug
 * came from that one contended file. Here nobody writes to anyone else's file,
 * so concurrent writes cannot happen, a closed group simply stops appearing in
 * the next write, and there is nothing to merge.
 *
 * Identity is the name, not a generated id. Reinstalling and typing the same
 * name resumes the same file instead of leaving a ghost behind.
 */

export const SCHEMA_VERSION = 2;

export const keyDevice = (name) => `${name}.json`;
export const keyHistory = (name, ts) => `history/${name}/${ts}.json`;
export const prefixHistory = (name) => `history/${name}/`;

/** Device files sit at the root; anything nested is history or something else. */
const DEVICE_FILE = /^([A-Za-z0-9_-]+)\.json$/;

export function deviceNameFromKey(key) {
  const m = DEVICE_FILE.exec(key);
  return m ? m[1] : null;
}

/**
 * Names become filenames, so they are restricted to what every backend — WebDAV
 * paths, Git paths, storage.sync keys — carries without escaping. Spaces become
 * underscores rather than being rejected, so typing stays natural.
 */
export function normaliseDeviceName(raw) {
  return (raw || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
}

export function isValidDeviceName(name) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(name || '');
}

export const GROUP_COLORS = [
  'blue', 'cyan', 'green', 'grey', 'orange',
  'pink', 'purple', 'red', 'yellow'
];

/** Schemes that cannot be reopened on another machine. */
const UNSYNCABLE_SCHEMES = [
  'about:', 'moz-extension:', 'chrome:', 'resource:',
  'javascript:', 'data:', 'blob:', 'view-source:', 'file:'
];

export function isSyncableUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return !UNSYNCABLE_SCHEMES.some((s) => lower.startsWith(s));
}

/**
 * favIconUrl travels as a string, never as image bytes: each computer fetches
 * and caches it. data: URIs are dropped because they would dominate the file.
 */
export function cleanFavIconUrl(url) {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('page-icon:')) return null;
  if (url.length > 500) return null;
  return url;
}

export function makeTabRecord(tab) {
  return {
    url: tab.url,
    title: (tab.title || '').slice(0, 300),
    pinned: !!tab.pinned,
    favIconUrl: cleanFavIconUrl(tab.favIconUrl),
    index: tab.index
  };
}

/**
 * The uuid is what makes a group recognisable when it is taken from another
 * computer twice: the second time it updates the group instead of opening a
 * duplicate beside it.
 */
export function makeGroupRecord({ uuid, title, color, collapsed, containerName, tabs }) {
  return {
    uuid,
    title: title || '',
    color: GROUP_COLORS.includes(color) ? color : 'grey',
    collapsed: !!collapsed,
    // Container ids differ per profile, so the name travels and is resolved by
    // name on arrival.
    containerName: containerName || null,
    tabs: tabs || []
  };
}

/** The payload of a device file, before sealing. */
export function makeDeviceBody(groups) {
  return { schema: SCHEMA_VERSION, groups };
}

/**
 * Cheap fingerprint of a whole session, used to skip writing when nothing has
 * changed. Synchronous and not cryptographic: it only needs to detect change.
 */
export function sessionSignature(groups) {
  const material = groups
    .map((g) => [
      g.uuid, g.title, g.color, g.collapsed ? 1 : 0, g.containerName || '',
      ...g.tabs.map((t) => `${t.url}\u0000${t.title}\u0000${t.pinned ? 1 : 0}`)
    ].join('\u0001'))
    .sort()
    .join('\u0002');

  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function uuid() {
  return crypto.randomUUID();
}
