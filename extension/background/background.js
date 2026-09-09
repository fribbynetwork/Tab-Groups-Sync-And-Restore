import { getLocal, getPrefs, isConfigured, backendState } from '../lib/config.js';
import { rebuildMap, ensureUuid, refreshPrint } from './state.js';
import {
  runSync, checkOthers, openFrom, replaceWith, ignoreFrom,
  checkDeviceName, renameDevice
} from './sync-engine.js';
import { createAdapter } from '../adapters/index.js';

import { listSnapshots, readSnapshot, deleteSnapshot, deleteDevice } from './history.js';
import { listDevices } from './device-file.js';
import { restoreFromSnapshot, restoreSingleTab } from './restore.js';
import { captureAll } from './capture.js';
import * as masterKey from '../lib/crypto.js';
import {
  probeRemote, unlockAgainstRemote, rotateAndReEncrypt,
  disableEncryption, saveCredentials, keyStatus
} from './keyflow.js';

/**
 * There is no reliable "browser is closing" event: Firefox never implemented a
 * blocking onShutdown, and runtime.onSuspend gives no guarantee that async work
 * finishes. So the strategy is inverted — save continuously with a short
 * debounce, and the worst case is losing a few seconds rather than a session.
 */

const DEBOUNCE_MS = 4000;
const ALARM_SYNC = 'tgsr-sync';

let debounceTimer = null;

/* ---------- scheduling ---------- */

function scheduleSync() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSync().then(afterSync).catch(reportError);
  }, DEBOUNCE_MS);
}

async function installAlarm() {
  const prefs = await getPrefs();
  await browser.alarms.clear(ALARM_SYNC);
  await browser.alarms.create(ALARM_SYNC, {
    periodInMinutes: Math.max(5, prefs.syncIntervalMinutes)
  });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_SYNC) return;
  runSync().then(afterSync).catch(reportError);
  checkOthers().then(afterSync).catch(reportError);
});

/* ---------- lifecycle ---------- */

browser.runtime.onStartup.addListener(async () => {
  // groupIds are reassigned by session restore, so the map is stale by
  // definition and gets rebuilt before anything else touches it.
  await rebuildMap();
  await installAlarm();

  if (await isConfigured()) {
    // Startup looks, it never acts. Whether to take another computer's groups
    // is always the user's decision, made from the popup.
    checkOthers().then(afterSync).catch(reportError);
    runSync().then(afterSync).catch(reportError);
  }
});

browser.runtime.onInstalled.addListener(async (details) => {
  await rebuildMap();
  await installAlarm();

  if (details.reason === 'install') {
    // The first-run questions have to be answered before anything is written,
    // so the settings page is opened rather than waiting to be found.
    await browser.runtime.openOptionsPage().catch(() => {});
  }
});

/* ---------- change detection ---------- */

let isConfiguredCached = false;
isConfigured().then((v) => { isConfiguredCached = v; });

const onChange = () => { if (isConfiguredCached) scheduleSync(); };

browser.tabs.onCreated.addListener(onChange);
browser.tabs.onRemoved.addListener(onChange);
browser.tabs.onMoved.addListener(onChange);
browser.tabs.onAttached.addListener(onChange);
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // groupId changes arrive here too: that is a tab joining or leaving a group.
  if (!('url' in changeInfo || 'groupId' in changeInfo || 'title' in changeInfo)) return;
  if (tab?.groupId !== undefined && tab.groupId !== -1) {
    await refreshPrint(tab.groupId).catch(() => {});
  }
  onChange();
});

browser.tabGroups.onCreated.addListener(async (group) => {
  await ensureUuid(group.id, group);
  onChange();
});

// The recorded print has to follow the group as it is edited. Without a
// per-group session store to hang the uuid on, that record is the only thing
// that re-attaches an identity after a restart, and a stale one matches nothing.
browser.tabGroups.onUpdated.addListener(async (group) => {
  await refreshPrint(group.id, group).catch(() => {});
  onChange();
});
browser.tabGroups.onMoved.addListener(onChange);

// A closed group needs no announcement: this computer's file is simply written
// without it, and no other machine changes until its user asks.
browser.tabGroups.onRemoved.addListener(onChange);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.prefs) {
    isConfigured().then((v) => { isConfiguredCached = v; });
    installAlarm();
  }
});

/* ---------- badge ---------- */

async function afterSync(result) {
  if (!result || result.skipped) return;
  await updateBadge();
}

async function updateBadge() {
  // A locked extension cannot sync at all, so that takes priority over the
  // count of pending remote changes.
  const key = await keyStatus().catch(() => ({ state: 'off' }));
  if (key.state === 'locked') {
    await browser.action.setBadgeText({ text: '\u{1F512}' }).catch(() => {});
    await browser.action.setBadgeBackgroundColor({ color: '#7a5100' }).catch(() => {});
    return;
  }

  const local = await getLocal();
  const prefs = await getPrefs();
  const count = (backendState(local, prefs.backend).pendingDevices || []).length;
  await browser.action.setBadgeText({ text: count ? String(count) : '' });
  await browser.action.setBadgeBackgroundColor({ color: '#0060df' });
}

async function reportError(e) {
  console.error('[tgsr]', e);
  await browser.action.setBadgeText({ text: '!' }).catch(() => {});
  await browser.action.setBadgeBackgroundColor({ color: '#d7264c' }).catch(() => {});
}

/* ---------- messaging ---------- */

/** The popup and the Settings page drive everything through here. */
browser.runtime.onMessage.addListener(async (message) => {
  switch (message?.type) {
    case 'sync-now': {
      const result = await runSync({ force: true });
      await checkOthers().catch(() => {});
      await afterSync(result);
      return result;
    }

    case 'check-others':
      return checkOthers();

    case 'open-from': {
      const result = await openFrom(message.device);
      await updateBadge();
      return result;
    }

    case 'replace-with': {
      const result = await replaceWith(message.device);
      await updateBadge();
      return result;
    }

    case 'ignore-from': {
      const result = await ignoreFrom(message.device);
      await updateBadge();
      return result;
    }

    case 'check-device-name':
      return checkDeviceName(message.name);

    case 'rename-device': {
      const result = await renameDevice(message.name);
      await runSync({ force: true }).catch(() => {});
      return result;
    }

    case 'status': {
      const local = await getLocal();
      const prefs = await getPrefs();
      const state = backendState(local, prefs.backend);
      return {
        configured: await isConfigured(),
        backend: prefs.backend,
        deviceName: local.deviceName,
        setupDone: local.setupDone,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
        lastErrorAt: state.lastErrorAt,
        pendingDevices: state.pendingDevices || [],
        unreadableDevices: state.unreadableDevices || [],
        encryptionEnabled: prefs.encryption.enabled,
        unlocked: await masterKey.isUnlocked(),
        keyState: (await keyStatus()).state,
        keyMismatch: !!(await keyStatus()).mismatch
      };
    }

    case 'test-connection': {
      const adapter = await createAdapter();
      if (!adapter) return { ok: false, code: 'generic', detail: 'no backend' };
      return adapter.test();
    }

    case 'current-groups':
      // Feeds the "right now this matches" preview in the filter settings.
      return captureAll({ applyFilter: false });

    case 'recently-closed': {
      const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 15 });
      return sessions;
    }

    case 'list-devices': {
      const adapter = await createAdapter();
      const local = await getLocal();
      if (!adapter) return [];
      return listDevices(adapter, { selfName: local.deviceName });
    }

    case 'list-snapshots': {
      const adapter = await createAdapter();
      const local = await getLocal();
      if (!adapter?.capabilities.history) return [];
      return listSnapshots(adapter, message.device || local.deviceName);
    }

    case 'delete-snapshot': {
      const adapter = await createAdapter();
      await deleteSnapshot(adapter, message.key);
      return { ok: true };
    }

    case 'delete-device': {
      const adapter = await createAdapter();
      const removed = await deleteDevice(adapter, message.device);
      return { removed };
    }

    case 'read-snapshot': {
      const adapter = await createAdapter();
      return readSnapshot(adapter, message.key);
    }

    case 'restore-group':
      return restoreFromSnapshot(message.group);

    case 'restore-tab':
      return restoreSingleTab(message.tab);

    case 'probe-remote':
      return probeRemote();

    case 'key-status':
      return keyStatus();

    case 'unlock': {
      // Works for both the first computer (nothing encrypted yet) and a later
      // one (derive against the salt already on the server).
      const result = await unlockAgainstRemote(message.passphrase);
      await updateBadge();
      return result;
    }

    case 'rotate-key':
      return rotateAndReEncrypt(message.passphrase);

    case 'disable-encryption':
      await disableEncryption();
      return { ok: true };

    case 'save-credentials':
      return { saved: await saveCredentials() };

    case 'lock':
      await masterKey.lock();
      return { ok: true };

    default:
      return undefined;
  }
});

updateBadge().catch(() => {});
