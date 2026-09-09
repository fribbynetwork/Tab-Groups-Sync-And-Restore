/**
 * The group filter is per-computer and lives in storage.local. If it were
 * synced it would be identical everywhere, which would defeat the point: the
 * whole idea is a shared base with a different selection per machine.
 *
 * Rules match on the group name, but names change. So the Settings page resolves
 * rules to the groups they currently hit and shows them, which is how a user
 * notices that a rule stopped matching anything after a rename.
 */

/** Case-insensitive, with a trailing or leading * for prefix/suffix matching. */
export function ruleMatches(rule, title) {
  const r = (rule || '').trim().toLowerCase();
  const t = (title || '').trim().toLowerCase();
  if (!r) return false;

  const starts = r.startsWith('*');
  const ends = r.endsWith('*');
  const core = r.replace(/^\*/, '').replace(/\*$/, '');
  if (!core) return true;

  if (starts && ends) return t.includes(core);
  if (starts) return t.endsWith(core);
  if (ends) return t.startsWith(core);
  return t === core;
}

export function shouldSyncOutgoing(filter, title) {
  const rules = (filter.rules || []).filter(Boolean);
  switch (filter.mode) {
    case 'exclude': return !rules.some((r) => ruleMatches(r, title));
    case 'include': return rules.some((r) => ruleMatches(r, title));
    default: return true;
  }
}

/**
 * "Do not publish my Work group" and "do not open the laptop's groups here" are
 * different needs. One list covers both, with a switch for the second.
 */
export function shouldAcceptIncoming(filter, title) {
  if (!filter.applyIncoming) return true;
  return shouldSyncOutgoing(filter, title);
}

/** Feeds the "right now this matches" preview in Settings. */
export function previewMatches(filter, groups) {
  return groups
    .filter((g) => !shouldSyncOutgoing(filter, g.title))
    .map((g) => ({ uuid: g.uuid, title: g.title }));
}
