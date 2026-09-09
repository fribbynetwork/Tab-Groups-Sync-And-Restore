import { makeGroupRecord, makeTabRecord, isSyncableUrl } from '../lib/schema.js';
import { shouldSyncOutgoing } from '../lib/filter.js';
import { ensureUuid, rememberFavicon } from './state.js';
import { getLocal } from '../lib/config.js';

/**
 * Reads the current tab groups and turns them into records.
 *
 * Tabs outside a group are never captured. That single rule gives the user a
 * local scratch space with no extra machinery, and it removes the "orphan tab"
 * category from the merge entirely.
 */
export async function captureAll({ applyFilter = true } = {}) {
  const local = await getLocal();
  const groups = await browser.tabGroups.query({});
  const containers = await listContainers();
  const out = [];

  for (const group of groups) {
    // Private windows are out of scope: their groups do not persist and their
    // contents should not leave the machine.
    const win = await browser.windows.get(group.windowId).catch(() => null);
    if (!win || win.incognito) continue;

    if (applyFilter && !shouldSyncOutgoing(local.filter, group.title)) continue;

    const record = await captureGroup(group, containers);
    if (record) out.push(record);
  }
  return out;
}

export async function captureGroup(group, containers) {
  const tabs = await browser.tabs.query({ groupId: group.id });

  const records = [];
  for (const tab of tabs.sort((a, b) => a.index - b.index)) {
    // Filtering happens at capture time, not restore time: an about: page is
    // not something we want sitting in history for two weeks either.
    if (!isSyncableUrl(tab.url)) continue;
    await rememberFavicon(tab.url, tab.favIconUrl);
    records.push(makeTabRecord(tab));
  }

  if (records.length === 0) return null;

  const uuid = await ensureUuid(group.id, group);
  return makeGroupRecord({
    uuid,
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    // Container ids are per-profile, so the name is what travels.
    containerName: containers.get(group.cookieStoreId) || null,
    tabs: records
  });
}

async function listContainers() {
  const map = new Map();
  try {
    const identities = await browser.contextualIdentities.query({});
    for (const id of identities) map.set(id.cookieStoreId, id.name);
  } catch { /* containers disabled in this profile */ }
  return map;
}

