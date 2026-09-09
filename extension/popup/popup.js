const $ = (id) => document.getElementById(id);
const msg = (key, subs) => browser.i18n.getMessage(key, subs);
const send = (message) => browser.runtime.sendMessage(message);

for (const el of document.querySelectorAll('[data-i18n]')) {
  const text = msg(el.dataset.i18n);
  if (text) el.textContent = text;
}

// The full explanation lives in the tooltip rather than in the layout.

let status = null;

async function refresh() {
  status = await send({ type: 'status' });

  $('lastSync').textContent = status.lastSyncAt
    ? msg('popupLastSync', [relativeTime(status.lastSyncAt)])
    : msg('popupNeverSynced');

  if (status.lastError) {
    const when = status.lastErrorAt
      ? ` ${msg('errorAt', [new Date(status.lastErrorAt).toLocaleTimeString()])}`
      : '';
    $('errorLine').hidden = false;
    $('errorLine').textContent = errorText(status.lastError) + when;
    $('copyDiag').hidden = false;
  } else {
    $('errorLine').hidden = true;
    $('copyDiag').hidden = true;
  }

  $('emptyState').hidden = status.configured;

  // Locked beats everything: nothing can be read, so offering the choices would
  // only produce the same failure.
  const locked = status.keyState === 'locked';
  $('unlockBox').hidden = !locked;
  $('syncNow').disabled = locked;
  if (locked) {
    $('unlockPrompt').textContent = status.keyMismatch
      ? msg('encStateChangedElsewhere')
      : msg('popupUnlockPrompt');
  }

  renderPending(locked ? [] : (status.pendingDevices || []));

  // Readable here or not is a different question from locked, and the two were
  // being conflated: a newcomer with its own password made every other computer
  // announce that the password had changed.
  const unreadable = status.unreadableDevices || [];
  $('unreadableLine').hidden = unreadable.length === 0;
  if (unreadable.length) {
    $('unreadableLine').textContent = msg('devicesUnreadable', [unreadable.join(', ')]);
  }

  await Promise.all([loadRecentlyClosed(), loadSnapshots()]);
}

/**
 * One block per computer that has changed, with the three things that can be
 * done about it. Nothing is applied on its own: a change sits here until the
 * user answers, and "do nothing" is an answer — it acknowledges the version so
 * the same change is not offered again.
 */
function renderPending(devices) {
  const box = $('pendingList');
  box.innerHTML = '';

  for (const device of devices) {
    const block = document.createElement('div');
    block.className = 'pending';

    const title = document.createElement('p');
    title.className = 'pending-text';
    title.textContent = msg('popupDeviceChanged', [device.name]);

    const when = document.createElement('span');
    when.className = 'pending-when';
    when.textContent = ' ' + msg('popupDeviceChangedWhen', [relativeTime(device.updatedAt)]);
    title.append(when);

    const actions = document.createElement('div');
    actions.className = 'pending-actions';
    actions.append(
      pendingButton('popupOpenHere', 'popupOpenHereTitle', 'btn', () =>
        send({ type: 'open-from', device: device.name })),
      pendingButton('popupReplaceHere', 'popupReplaceHereTitle', 'btn btn-warn', () =>
        send({ type: 'replace-with', device: device.name })),
      pendingButton('popupIgnore', 'popupIgnoreTitle', 'btn btn-quiet', () =>
        send({ type: 'ignore-from', device: device.name }))
    );

    const result = document.createElement('p');
    result.className = 'pending-note';
    result.hidden = true;

    block.append(title, actions, result);
    box.append(block);

    function pendingButton(labelKey, titleKey, className, run) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `${className} btn-small`;
      b.textContent = msg(labelKey);
      b.title = msg(titleKey);
      b.addEventListener('click', async () => {
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        b.textContent = msg('popupSyncing');
        try {
          const out = await run();
          result.hidden = false;
          result.textContent = out && 'opened' in out
            ? msg('popupApplied', [String(out.opened), String(out.closed || 0)])
            : msg('saved');
          await refresh();
        } catch (e) {
          // Without this the failure would be an unhandled rejection and a
          // popup that simply did nothing.
          result.hidden = false;
          result.textContent = String(e?.message || e);
          for (const other of actions.querySelectorAll('button')) other.disabled = false;
          b.textContent = msg(labelKey);
        }
      });
      return b;
    }
  }
}

/**
 * Firefox already tracks recently closed tabs locally. Since only grouped tabs
 * are synced, this covers exactly what the group history cannot.
 */
async function loadRecentlyClosed() {
  const list = $('closedList');
  const sessions = await send({ type: 'recently-closed' }).catch(() => []);
  list.innerHTML = '';

  const items = (sessions || []).slice(0, 6);
  if (!items.length) { list.append(emptyRow()); return; }

  for (const session of items) {
    const tab = session.tab;
    const win = session.window;
    if (tab) {
      list.append(entryRow({
        title: tab.title || tab.url,
        meta: hostOf(tab.url),
        icon: tab.favIconUrl,
        onClick: () => browser.sessions.restore(tab.sessionId).then(window.close)
      }));
    } else if (win) {
      list.append(entryRow({
        title: `${win.tabs?.length || 0} tabs`,
        meta: '',
        onClick: () => browser.sessions.restore(win.sessionId).then(window.close)
      }));
    }
  }
}

/** Only shown when the chosen destination can hold history at all. */
async function loadSnapshots() {
  const section = $('historySection');
  const list = $('historyList');

  const snapshots = await send({ type: 'list-snapshots' }).catch(() => []);
  if (!snapshots || !snapshots.length) {
    section.hidden = !status.configured;
    list.innerHTML = '';
    if (!section.hidden) list.append(emptyRow());
    return;
  }

  section.hidden = false;
  list.innerHTML = '';

  for (const snap of snapshots.slice(0, 5)) {
    list.append(entryRow({
      title: msg('snapshotAt', [
        new Date(snap.takenAt).toLocaleString(),
        status.deviceName || ''
      ]),
      meta: '',
      onClick: () => openSnapshot(snap.key)
    }));
  }
}

async function openSnapshot(key) {
  const snapshot = await send({ type: 'read-snapshot', key }).catch(() => null);
  if (!snapshot) return;

  const list = $('historyList');
  list.innerHTML = '';
  list.append(entryRow({ title: '\u2190', meta: '', onClick: loadSnapshots }));

  for (const group of snapshot.groups || []) {
    list.append(entryRow({
      title: group.title || '\u2014',
      meta: `${group.tabs.length}`,
      onClick: async () => {
        await send({ type: 'restore-group', group });
        window.close();
      }
    }));
  }
}

/* ---------- rendering helpers ---------- */

function entryRow({ title, meta, icon, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry';

  if (icon) {
    const img = document.createElement('img');
    img.className = 'entry-icon';
    img.src = icon;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    button.append(img);
  }

  const text = document.createElement('span');
  text.className = 'entry-text';

  const t = document.createElement('span');
  t.className = 'entry-title';
  t.textContent = title;
  text.append(t);

  if (meta) {
    const m = document.createElement('span');
    m.className = 'entry-meta';
    m.textContent = meta;
    text.append(m);
  }

  button.append(text);
  button.addEventListener('click', onClick);
  return button;
}

function emptyRow() {
  const p = document.createElement('p');
  p.className = 'list-empty';
  p.textContent = '—';
  return p;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function relativeTime(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(browser.i18n.getUILanguage(), { numeric: 'auto' });
  if (seconds < 60) return rtf.format(-seconds, 'second');
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  return rtf.format(-Math.round(seconds / 86400), 'day');
}

function errorText(error) {
  switch (error.code) {
    case 'quota': return msg('quotaExceeded');
    case 'schema': return msg('syncFailSchema');
    case 'conflict': return msg('syncFailConflict');
    case 'passwordChanged': return msg('encStateChangedElsewhere');
    case 'locked': return msg('syncPausedLocked');
    case 'wrongPassphrase': return msg('masterPasswordWrong');
    case 'auth': return msg('testFailAuth');
    case 'network': return msg('testFailNetwork');
    case 'permission': return msg('testFailPermission');
    default: return msg('testFailGeneric', [error.detail || '']);
  }
}

/* ---------- actions ---------- */

$('syncNow').addEventListener('click', async () => {
  $('syncNow').disabled = true;
  $('syncNow').textContent = msg('popupSyncing');
  try {
    await send({ type: 'sync-now' });
  } finally {
    $('syncNow').disabled = false;
    $('syncNow').textContent = msg('popupSyncNow');
    await refresh();
  }
});

/**
 * Lost when the popup was rewritten: the field was still rendered, the button
 * still drawn, and nothing was listening. Typing the password did nothing at
 * all, which is worse than not offering it.
 */
async function unlock() {
  const pass = $('unlockPass').value;
  if (!pass) return;

  const err = $('unlockError');
  err.hidden = true;
  $('unlockBtn').disabled = true;

  try {
    await send({ type: 'unlock', passphrase: pass });
    $('unlockPass').value = '';
    await send({ type: 'sync-now' });
    await refresh();
  } catch (e) {
    err.hidden = false;
    err.textContent = /wrong-passphrase/.test(String(e?.message || e))
      ? msg('masterPasswordWrong')
      : String(e?.message || e);
  } finally {
    $('unlockBtn').disabled = false;
  }
}

$('unlockBtn').addEventListener('click', unlock);
$('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

$('copyDiag').addEventListener('click', async () => {
  const trace = await send({ type: 'get-trace' }).catch(() => null);
  const text = (trace || [])
    .map((t) => t.note
      ? `--- ${t.note}`
      : `${String(t.status).padEnd(4)} ${t.method.padEnd(9)} ${t.path}` +
        (t.ifMatch ? ` If-Match:${t.ifMatch}` : '') +
        (t.etag ? `  ETag=${t.etag}` : '') +
        (t.error ? `  ${t.error}` : ''))
    .join('\n');
  await navigator.clipboard.writeText(text || '(empty)').catch(() => {});
  $('copyDiag').textContent = msg('copied');
});

$('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

refresh();
