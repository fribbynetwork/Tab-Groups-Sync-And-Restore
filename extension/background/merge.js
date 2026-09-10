import { makeIndexEntry, pruneTombstones } from '../lib/schema.js';

/**
 * The unit of synchronisation is the group, not the tab.
 *
 * Per-tab merging looks more refined but produces zombies: close a tab on
 * computer A, and computer B — which still has it — puts it back. Taking a group
 * whole from whichever machine touched it last is a rule that can be explained
 * to a user in one sentence, and it never resurrects anything.
 *
 * Deciding *whether* a group changed needs a third point of reference besides
 * "mine" and "theirs": the state at the last successful sync. `syncedHashes`
 * holds it, one hash per group, kept on this computer. Without it a capture,
 * which always carries the current time, looks newer than the remote copy every
 * single pass, and every group is re-uploaded forever.
 */

export function mergeIndex(remoteIndex, localGroups, deviceId, syncedHashes = {}, now = Date.now()) {
  const index = structuredClone(remoteIndex);
  index.groups ||= {};
  index.tombstones ||= {};

  const toUpload = [];
  const toApply = [];
  const localByUuid = new Map(localGroups.map((g) => [g.uuid, g]));

  for (const group of localGroups) {
    const remote = index.groups[group.uuid];
    const tomb = index.tombstones[group.uuid];
    const base = syncedHashes[group.uuid] || null;

    // Another computer deleted this group after our last change: honour it
    // rather than republishing.
    if (tomb && tomb.deletedAt > (remote?.updatedAt ?? 0) && tomb.deletedAt > group.updatedAt) {
      continue;
    }

    if (!remote) {
      group.rev = 1;
      toUpload.push(group);
      index.groups[group.uuid] = makeIndexEntry(group);
      continue;
    }

    const changedHere = base === null ? remote.hash !== group.hash : group.hash !== base;
    const changedThere = base !== null && remote.hash !== base;

    if (!changedHere && !changedThere) continue;          // nothing to do at all

    if (changedHere && !changedThere) {
      group.rev = (remote.rev || 0) + 1;
      toUpload.push(group);
      index.groups[group.uuid] = makeIndexEntry(group);
      continue;
    }

    if (!changedHere && changedThere) {
      toApply.push(group.uuid);
      continue;
    }

    // Both sides moved since the last sync. Only here does the timestamp
    // decide, and by now it means something: it is only bumped on a real change.
    if (group.updatedAt > remote.updatedAt) {
      group.rev = (remote.rev || 0) + 1;
      toUpload.push(group);
      index.groups[group.uuid] = makeIndexEntry(group);
    } else {
      toApply.push(group.uuid);
    }
  }

  // Groups that exist only remotely: candidates to open here.
  for (const [uuid, entry] of Object.entries(index.groups)) {
    if (localByUuid.has(uuid)) continue;
    if (index.tombstones[uuid]) continue;
    if (entry.deviceId === deviceId) continue;
    toApply.push(uuid);
  }

  index.devices ||= {};
  index.devices[deviceId] = { ...(index.devices[deviceId] || {}), lastSeen: now };
  index.updatedAt = now;
  pruneTombstones(index, now);

  return { index, toUpload, toApply: [...new Set(toApply)] };
}

/**
 * Deletions need an explicit record, otherwise the other computer republishes
 * the group and it comes back from the dead.
 *
 * Crucially, only a tabGroups.onRemoved seen while the browser was running
 * produces a tombstone. A group merely missing at startup means Firefox has not
 * finished restoring the session — treating that as a deletion would wipe the
 * user's groups on every launch.
 */
export function addTombstone(index, uuid, deviceId, now = Date.now()) {
  index.tombstones ||= {};
  index.tombstones[uuid] = { deletedAt: now, deviceId };
  delete index.groups[uuid];
  index.updatedAt = now;
  return index;
}

export function isDeleted(index, uuid) {
  return !!index.tombstones?.[uuid];
}
