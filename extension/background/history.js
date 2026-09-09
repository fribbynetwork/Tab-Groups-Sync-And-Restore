import { keyHistory, prefixHistory } from '../lib/schema.js';
import { seal, unseal } from '../lib/crypto.js';
import { getPrefs, historyAvailable } from '../lib/config.js';

/**
 * History exists for the case Firefox cannot cover: "what did my setup look like
 * on Tuesday" and "get that group back from the other computer". The plain
 * "I just closed a tab" case is already handled by sessions.getRecentlyClosed(),
 * which works with no backend at all — the two are shown side by side in the
 * popup because each covers what the other misses.
 *
 * One folder per computer. A single merged history would mix machines that, by
 * the user's own filter settings, deliberately hold different groups.
 *
 * Nobody prunes this for us, so we do it on every write.
 */

export async function saveSnapshot(adapter, deviceName, groups) {
  const prefs = await getPrefs();
  if (!prefs.history.enabled) return null;
  if (!historyAvailable(prefs.backend)) return null;
  if (!deviceName) return null;

  const ts = Date.now();
  const envelope = await seal(
    { takenAt: ts, device: deviceName, groups },
    { encrypted: prefs.encryption.enabled }
  );

  await adapter.write(keyHistory(deviceName, ts), envelope, null);
  await prune(adapter, deviceName, prefs.history);
  return ts;
}

export async function listSnapshots(adapter, deviceName) {
  const entries = await adapter.list(prefixHistory(deviceName)).catch(() => []);
  return entries
    .map((e) => ({ key: e.key, takenAt: timestampFromKey(e.key) }))
    .filter((e) => e.takenAt !== null)
    .sort((a, b) => b.takenAt - a.takenAt);
}

export async function readSnapshot(adapter, key) {
  const result = await adapter.read(key);
  if (!result) return null;
  return unseal(result.data);
}

async function prune(adapter, deviceId, settings) {
  const snapshots = await listSnapshots(adapter, deviceId);
  const cutoff = Date.now() - settings.keepDays * 24 * 60 * 60 * 1000;

  const doomed = snapshots.filter(
    (s, i) => i >= settings.keepPerDevice || s.takenAt < cutoff
  );

  for (const s of doomed) {
    await adapter.remove(s.key).catch(() => {});
  }
  return doomed.length;
}

/** Removes one snapshot. */
export async function deleteSnapshot(adapter, key) {
  await adapter.remove(key);
}

/**
 * Removes a computer: its snapshots go, and its entry leaves the index.
 *
 * The groups it published stay. Once shared they belong to every machine, and
 * deleting them because one contributor is retired would take them off the
 * others too.
 */
/**
 * Removes a computer entirely: its file and its snapshots.
 *
 * With one file per device there is no register to keep in step — the folder
 * listing is the register, so a deleted file simply stops being a device.
 */
export async function deleteDevice(adapter, deviceName) {
  const entries = await adapter.list(prefixHistory(deviceName)).catch(() => []);
  for (const entry of entries) {
    await adapter.remove(entry.key).catch(() => {});
  }
  await adapter.remove(`${deviceName}.json`).catch(() => {});
  return entries.length;
}

function timestampFromKey(key) {
  const m = key.match(/(\d{10,})\.json$/);
  return m ? Number(m[1]) : null;
}
