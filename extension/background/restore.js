import { GROUP_COLORS, isSyncableUrl } from '../lib/schema.js';
import { shouldAcceptIncoming } from '../lib/filter.js';
import { bind, groupIdForUuid, ensureUuid, unbind } from './state.js';
import { getLocal } from '../lib/config.js';

/**
 * Applies remote groups to this computer.
 *
 * This reconciles, it never applies blindly. Firefox has already restored the
 * session with its own groups by the time we run, so opening everything from
 * the server would duplicate the lot.
 */
export async function applyGroups(records, { windowId } = {}) {
  const local = await getLocal();
  const applied = [];

  for (const record of records) {
    if (!shouldAcceptIncoming(local.filter, record.title)) continue;

    const existingId = groupIdForUuid(record.uuid);
    if (existingId !== null && await groupExists(existingId)) {
      await updateExistingGroup(existingId, record);
      applied.push(record.uuid);
    } else {
      const created = await createGroup(record, windowId);
      if (created !== null) applied.push(record.uuid);
    }
  }
  return applied;
}

async function groupExists(groupId) {
  try {
    await browser.tabGroups.get(groupId);
    return true;
  } catch {
    return false;
  }
}

async function createGroup(record, windowId) {
  const urls = record.tabs.filter((t) => isSyncableUrl(t.url));
  if (urls.length === 0) return null;

  const cookieStoreId = await resolveContainer(record.containerName);
  const tabIds = [];

  for (const tab of urls) {
    const props = {
      url: tab.url,
      active: false,
      // Without this a restored session of thirty tabs would load thirty pages
      // at once. Firefox will not fetch the favicon for a discarded tab either,
      // which is why the synced favIconUrl string matters.
      discarded: true,
      title: tab.title || tab.url,
      pinned: tab.pinned
    };
    if (windowId) props.windowId = windowId;
    if (cookieStoreId) props.cookieStoreId = cookieStoreId;

    try {
      const created = await browser.tabs.create(props);
      tabIds.push(created.id);
    } catch {
      // A container may have been removed, or the URL may be refused. Skipping
      // one tab is better than losing the whole group.
    }
  }

  if (tabIds.length === 0) return null;

  const groupId = await browser.tabs.group({
    tabIds,
    createProperties: windowId ? { windowId } : {}
  });

  await browser.tabGroups.update(groupId, {
    title: record.title,
    color: GROUP_COLORS.includes(record.color) ? record.color : 'grey',
    collapsed: record.collapsed
  });

  await bind(record.uuid, groupId);
  return groupId;
}

async function updateExistingGroup(groupId, record) {
  await browser.tabGroups.update(groupId, {
    title: record.title,
    color: GROUP_COLORS.includes(record.color) ? record.color : 'grey',
    collapsed: record.collapsed
  }).catch(() => {});

  const current = await browser.tabs.query({ groupId });
  const currentUrls = new Set(current.map((t) => t.url));
  const wantedUrls = new Set(record.tabs.map((t) => t.url));

  // Open before closing, always.
  //
  // Removing every tab of a group destroys the group itself: the groupId dies,
  // the regroup that follows fails against it, and — worse — tabGroups.onRemoved
  // fires and publishes a tombstone, deleting on the server the very group we
  // are in the middle of receiving from it.
  const missing = record.tabs.filter((t) => !currentUrls.has(t.url) && isSyncableUrl(t.url));
  const newIds = [];
  for (const tab of missing) {
    try {
      const created = await browser.tabs.create({
        url: tab.url,
        active: false,
        discarded: true,
        title: tab.title || tab.url,
        pinned: tab.pinned
      });
      newIds.push(created.id);
    } catch { /* skip this tab */ }
  }
  if (newIds.length) await browser.tabs.group({ tabIds: newIds, groupId }).catch(() => {});

  // Now the group is guaranteed to survive losing the stale ones.
  const stale = current.filter((t) => !wantedUrls.has(t.url));
  if (stale.length) await browser.tabs.remove(stale.map((t) => t.id)).catch(() => {});
}

/**
 * Closes the named groups and their tabs.
 *
 * Resolved against the live groups rather than the stored uuid → groupId map:
 * that map is a cache which survives restarts while group ids do not, and a
 * stale entry would silently close nothing.
 *
 * Closing no longer has to be announced anywhere. This computer's file is
 * simply written without them next time, and no other machine is affected
 * until its user asks for the change.
 */
export async function closeGroups(uuids) {
  const wanted = new Set(uuids);
  const live = await browser.tabGroups.query({});
  let closed = 0;

  for (const group of live) {
    const uuid = await ensureUuid(group.id);
    if (!wanted.has(uuid)) continue;

    const tabs = await browser.tabs.query({ groupId: group.id }).catch(() => []);
    if (!tabs.length) continue;

    await browser.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
    await unbind(uuid);
    closed++;
  }
  return closed;
}

/**
 * Containers are resolved by name because the ids differ between profiles.
 * If the name is unknown here, the group lands in the default container rather
 * than failing.
 */
async function resolveContainer(name) {
  if (!name) return null;
  try {
    const matches = await browser.contextualIdentities.query({ name });
    return matches[0]?.cookieStoreId || null;
  } catch {
    return null;
  }
}

/** Restores a single group from a history snapshot, always as a new group. */
export async function restoreFromSnapshot(record) {
  return createGroup({ ...record, uuid: record.uuid }, null);
}

/** Restores one tab out of a snapshot, into the current window. */
export async function restoreSingleTab(tab) {
  if (!isSyncableUrl(tab.url)) return null;
  return browser.tabs.create({ url: tab.url, active: true });
}
