import { getLocal, setLocal } from '../lib/config.js';
import { uuid } from '../lib/schema.js';

/**
 * groupId is a local integer that Firefox reassigns on session restore, so it
 * cannot be synced. Every group gets our own stable uuid instead, and the map
 * between the two is rebuilt at startup and kept in storage.local.
 *
 * Anchoring the uuid to per-group session storage would be the natural answer,
 * but Firefox has no such API — sessions.getTabGroupValue does not exist. The
 * uuid is therefore re-attached by recognising the group itself.
 */

let map = null;          // uuid -> groupId
let reverse = null;      // groupId -> uuid

export async function loadMap() {
  const local = await getLocal();
  map = { ...local.groupIdMap };
  reverse = {};
  for (const [u, gid] of Object.entries(map)) reverse[gid] = u;
  return map;
}

async function persist() {
  await setLocal({ groupIdMap: map });
}

export function uuidForGroupId(groupId) {
  return reverse?.[groupId] || null;
}

export function groupIdForUuid(u) {
  return map?.[u] ?? null;
}

/** Kept current as groups are edited, or the record ages into uselessness. */
export async function refreshPrint(groupId, group = null) {
  if (!map) await loadMap();
  const u = reverse[groupId];
  if (!u) return;
  const info = group || await browser.tabGroups.get(groupId).catch(() => null);
  await rememberPrint(u, await printOf(groupId, info));
}

export async function bind(u, groupId) {
  if (!map) await loadMap();
  const previous = map[u];
  if (previous !== undefined) delete reverse[previous];
  map[u] = groupId;
  reverse[groupId] = u;
  await persist();
}

export async function unbind(u) {
  if (!map) await loadMap();
  const gid = map[u];
  if (gid !== undefined) delete reverse[gid];
  delete map[u];
  await persist();
}

/**
 * A group's identity, for re-attaching its uuid after a restart.
 *
 * Firefox reassigns group ids when it restores a session, and there is no
 * per-group session storage to hang a stable id on: sessions.getTabGroupValue
 * and setTabGroupValue do not exist. This is therefore not a fallback but the
 * whole mechanism, so it has to survive ordinary editing.
 *
 * Title and first tab are recorded separately rather than as one string. A
 * combined fingerprint breaks the moment a tab is added, and losing a group's
 * identity means it looks brand new to every other computer.
 */
async function printOf(groupId, group) {
  const tabs = await browser.tabs.query({ groupId }).catch(() => []);
  const first = tabs.sort((a, b) => a.index - b.index)[0];
  return { title: group?.title || '', firstUrl: first?.url || '' };
}

/**
 * Best match for a live group among the uuids recorded earlier.
 *
 * Both parts matching is conclusive. One part matching is still far better than
 * minting a new identity: renaming a group keeps its tabs, and replacing its
 * first tab keeps its name.
 */
function scorePrint(a, b) {
  if (!a || !b) return 0;
  let score = 0;
  if (a.title && a.title === b.title) score += 2;
  if (a.firstUrl && a.firstUrl === b.firstUrl) score += 2;
  return score;
}

export async function ensureUuid(groupId, group = null) {
  if (!map) await loadMap();

  const known = reverse[groupId];
  if (known) return known;

  const info = group || await browser.tabGroups.get(groupId).catch(() => null);
  const print = await printOf(groupId, info);

  const local = await getLocal();
  let best = null;
  let bestScore = 0;
  for (const [candidate, stored] of Object.entries(local.groupPrints || {})) {
    // A uuid already bound to a live group is not available to claim.
    if (map[candidate] !== undefined) continue;
    const score = scorePrint(print, stored);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }

  const u = best || uuid();
  await bind(u, groupId);
  await rememberPrint(u, print);
  return u;
}

async function rememberPrint(u, print) {
  const local = await getLocal();
  const stored = local.groupPrints?.[u];
  if (stored && stored.title === print.title && stored.firstUrl === print.firstUrl) return;
  await setLocal({ groupPrints: { ...local.groupPrints, [u]: print } });
}

/**
 * Rebuilt at startup because group ids are reassigned by session restore.
 *
 * The uuid ↔ group association is re-derived rather than thrown away: losing it
 * would give every group a new identity on every launch, and this computer's
 * file would look changed to all the others every single time.
 */
export async function rebuildMap() {
  map = {};
  reverse = {};
  const groups = await browser.tabGroups.query({});
  for (const g of groups) await ensureUuid(g.id, g);
  await persist();

  // Fingerprints of groups that no longer exist would accumulate for ever.
  const live = new Set(Object.keys(map));
  const local = await getLocal();
  const kept = Object.fromEntries(
    Object.entries(local.groupPrints || {}).filter(([u]) => live.has(u))
  );
  await setLocal({ groupPrints: kept });

  return map;
}

/* ---------- favicon cache ---------- */

/**
 * Only the favIconUrl string is synced; the image itself is fetched and cached
 * per origin on each computer, so thirty tabs from a dozen sites cost a dozen
 * entries rather than thirty.
 */
export async function rememberFavicon(url, favIconUrl) {
  if (!favIconUrl) return;
  try {
    const origin = new URL(url).origin;
    const local = await getLocal();
    if (local.faviconCache[origin] === favIconUrl) return;
    await setLocal({ faviconCache: { ...local.faviconCache, [origin]: favIconUrl } });
  } catch { /* not a parseable URL */ }
}

export async function lookupFavicon(url) {
  try {
    const origin = new URL(url).origin;
    const local = await getLocal();
    return local.faviconCache[origin] || null;
  } catch {
    return null;
  }
}
