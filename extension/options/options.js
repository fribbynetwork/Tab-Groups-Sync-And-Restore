import {
  getPrefs, setPrefs, getLocal, setLocal,
  historyAvailable, exportSettings, importSettings, isConfigured,
  credentialsFor, setCredentials, backendState
} from '../lib/config.js';
import { testResultMessage, startLoginFlow, pollLoginFlow, fetchUserId, WebdavAdapter,
  RestAdapter, requestHostPermission, originPatternFor } from '../adapters/index.js';
import { previewMatches } from '../lib/filter.js';
import { normaliseDeviceName, isValidDeviceName } from '../lib/schema.js';

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => browser.i18n.getMessage(key, subs);

let prefs, local;
let lastKnownFolder = null;

/* ---------- i18n ---------- */

function localise() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const text = msg(el.dataset.i18n);
    if (text) el.textContent = text;
  }

  // A dropdown of bare numbers does not say what they count.
  for (const select of document.querySelectorAll('select[data-unit]')) {
    for (const option of select.options) {
      option.textContent = msg(select.dataset.unit, [option.value]);
    }
  }
  document.documentElement.lang = browser.i18n.getUILanguage();
}

/* ---------- the device name ---------- */

/**
 * The name becomes a filename, so it is normalised as it is typed rather than
 * rejected afterwards: spaces turn into underscores and anything a path cannot
 * carry is dropped. Seeing the resulting filename removes the guesswork.
 */
function wireNameField(inputId, fileId, stateId, forceId) {
  const input = $(inputId);
  let forced = false;

  const check = async () => {
    const raw = input.value;
    const name = normaliseDeviceName(raw);
    if (name !== raw) input.value = name;

    $(fileId).textContent = name ? msg('deviceNameFile', [`${name}.json`]) : '';
    const state = $(stateId);
    if (forceId) $(forceId).hidden = true;

    if (!isValidDeviceName(name)) {
      state.hidden = false;
      state.className = 'state-line is-warn';
      state.textContent = msg('deviceNameInvalid');
      return { name, ok: false };
    }

    const result = await browser.runtime.sendMessage({ type: 'check-device-name', name })
      .catch(() => ({ status: 'free' }));

    state.hidden = false;
    if (result.status === 'mine') {
      state.className = 'state-line is-ok';
      state.textContent = msg('deviceNameMine');
      return { name, ok: true };
    }
    if (result.status === 'taken') {
      // Taking over an existing file is exactly right after a reinstall and
      // exactly wrong between two live machines, and only the user knows which.
      state.className = 'state-line is-warn';
      state.textContent = msg('deviceNameTaken',
        [new Date(result.updatedAt).toLocaleString()]);
      if (forceId) $(forceId).hidden = forced;
      return { name, ok: forced };
    }
    state.className = 'state-line is-ok';
    state.textContent = msg('deviceNameFree');
    return { name, ok: true };
  };

  input.addEventListener('input', debounce(check, 400));
  if (forceId) {
    $(forceId).addEventListener('click', () => {
      forced = true;
      $(forceId).hidden = true;
      $(stateId).className = 'state-line is-ok';
    });
  }
  return check;
}

let checkSetupName = null;
let checkAdvancedName = null;

async function renameThisDevice() {
  const status = $('deviceRenameStatus');
  const result = await checkAdvancedName();
  if (!result.ok) return;

  status.className = 'status is-busy';
  status.textContent = msg('encWorking');
  try {
    await browser.runtime.sendMessage({ type: 'rename-device', name: result.name });
    local = await getLocal();
    $('deviceLine').textContent = local.deviceName;
    status.className = 'status is-ok';
    status.textContent = msg('saved');
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = String(e?.message || e);
  }
}

/* ---------- first run ---------- */

/**
 * Three steps, in the order the decisions actually depend on each other:
 * name, then destination, then encryption.
 *
 * Encryption has to come last because it is the only step that needs the server:
 * until the destination is connected there is no way to tell "nothing is
 * encrypted yet" from "encrypted by another computer, and this one has not been
 * told". Asking earlier meant minting a key from a fresh salt that decrypted
 * nothing.
 *
 * The wizard walks the real Sync and Security panels instead of repeating their
 * controls, so the master password is asked in exactly one place in the whole
 * extension.
 */

function inSetup() {
  return !local.setupDone;
}

async function refreshWizard() {
  const active = inSetup();
  const step = local.setupStep || 'name';

  $('navSetup').hidden = !active;
  $('wizardSync').hidden = !(active && step === 'destination');
  $('wizardSecurity').hidden = !(active && step === 'encryption');

  if (!active) return;

  $('setupBadge').textContent = msg('setupStep', ['1']);
  $('wizardSyncBadge').textContent = msg('setupStep', ['2']);
  $('wizardSecBadge').textContent = msg('setupStep', ['3']);

  // Only the step in hand is reachable; the rest would just invite wrong turns.
  for (const item of document.querySelectorAll('.nav-item')) {
    const panel = item.dataset.panel;
    item.hidden = !(
      (panel === 'setup' && step === 'name') ||
      (panel === 'sync' && step === 'destination') ||
      (panel === 'security' && step === 'encryption')
    );
  }

  if (step === 'name') showPanel('setup');
  else if (step === 'destination') showPanel('sync');
  else showPanel('security');
}

async function setupStepName() {
  const result = await checkSetupName();
  if (!result.ok) return;

  await setLocal({ deviceName: result.name, setupStep: 'destination' });
  local = await getLocal();
  await load();
  await refreshWizard();
}

async function setupStepDestination() {
  const status = $('saveStatus');
  await save({ silent: true });

  if (!(await isConfigured())) {
    status.className = 'save-status is-error';
    status.textContent = msg('setupDestPrompt');
    return;
  }

  await setLocal({ setupStep: 'encryption' });
  local = await getLocal();
  await refreshWizard();
  await refreshKeyState();
}

async function finishSetup() {
  await setLocal({ setupDone: true, setupStep: 'done' });
  local = await getLocal();

  for (const item of document.querySelectorAll('.nav-item')) item.hidden = false;
  $('navSetup').hidden = true;

  await load();
  await refreshWizard();
  showPanel('sync');

  // Nothing was written before this point: the first sync waits for every
  // question to be answered.
  browser.runtime.sendMessage({ type: 'sync-now' }).catch(() => {});
}

/* ---------- navigation ---------- */

function showPanel(name) {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('is-current', item.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('is-current', panel.id === `panel-${name}`);
  }
  if (name === 'history') refreshHistoryBrowser();
}

function setupNav() {
  const show = (name) => {
    for (const item of document.querySelectorAll('.nav-item')) {
      item.classList.toggle('is-current', item.dataset.panel === name);
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('is-current', panel.id === `panel-${name}`);
    }
  };

  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = item.dataset.panel;
      showPanel(item.dataset.panel);
    });
  }
  show(location.hash.slice(1) || 'sync');
}

/* ---------- loading ---------- */

async function load() {
  prefs = await getPrefs();
  local = await getLocal();

  $('deviceLine').textContent = local.deviceName;

  if (prefs.backend) {
    const radio = document.querySelector(`input[name="backend"][value="${prefs.backend}"]`);
    if (radio) radio.checked = true;
  }
  $('interval').value = String(prefs.syncIntervalMinutes);

  $('webdavUrl').value = prefs.webdav.serverUrl;
  $('davUrl').value = prefs.webdav.davUrl;
  const modeRadioDav = document.querySelector(`input[name="webdavMode"][value="${prefs.webdav.mode}"]`);
  if (modeRadioDav) modeRadioDav.checked = true;
  if (prefs.webdav.mode === 'generic' && webdavCreds) {
    $('davUser').value = webdavCreds.user || '';
    if (webdavCreds.secret) $('davPass').value = '••••••••';
  }
  $('webdavFolder').value = prefs.webdav.folderPath;
  lastKnownFolder = prefs.webdav.folderPath;
  $('restUrl').value = prefs.rest.endpointUrl;
  $('gitBase').value = prefs.git.baseUrl;
  $('gitRepo').value = prefs.git.repo;
  $('gitBranch').value = prefs.git.branch;
  $('gitPath').value = prefs.git.path;

  $('encSyncCreds').checked = prefs.encryption.syncCredentials;

  $('historyEnabled').checked = prefs.history.enabled;
  $('historyDays').value = String(prefs.history.keepDays);
  $('historyCount').value = String(prefs.history.keepPerDevice);

  const modeRadio = document.querySelector(`input[name="filterMode"][value="${local.filter.mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  $('filterRules').value = (local.filter.rules || []).join('\n');
  $('filterIncoming').checked = local.filter.applyIncoming;

  $('deviceName').value = local.deviceName;
  $('setupName').value = local.deviceName || suggestedName();

  const webdavCreds = credentialsFor(local, 'webdav');
  const restCreds = credentialsFor(local, 'rest');
  const gitCreds = credentialsFor(local, 'git');

  if (webdavCreds?.user) {
    $('webdavAuthStatus').textContent = msg('connected', [webdavCreds.user]);
    $('webdavAuthStatus').className = 'status is-ok';
  }
  if (restCreds?.secret) $('restToken').value = '••••••••';
  if (gitCreds?.secret) $('gitToken').value = '••••••••';

  refreshBackendVisibility();
  refreshBackendStates();
  await dropStalePortPatterns();
  await refreshPermissionState();
  renderTrace();
  refreshEncryptionVisibility();
  refreshHistoryVisibility();
  await refreshKeyState();
  refreshFilterVisibility();
  await refreshFilterPreview();
}

/* ---------- conditional visibility ---------- */

function currentBackend() {
  return document.querySelector('input[name="backend"]:checked')?.value || null;
}

function webdavMode() {
  return document.querySelector('input[name="webdavMode"]:checked')?.value || 'nextcloud';
}

function refreshWebdavMode() {
  const generic = webdavMode() === 'generic';
  $('webdavGeneric').hidden = !generic;
  // The Nextcloud login flow and its derived path only apply to Nextcloud.
  $('webdavNextcloudUrl').hidden = generic;
  $('webdavConnectRow').hidden = generic;
  $('webdavPermState').hidden = generic;
}

/**
 * Each destination keeps its own settings, credentials and sync state, so
 * moving between them is reversible. That is only reassuring if it is visible.
 */
function refreshBackendStates() {
  const configuredFor = {
    'browser-sync': true,
    webdav: !!(credentialsFor(local, 'webdav')
            && (prefs.webdav.serverUrl || prefs.webdav.davUrl)),
    rest: !!(prefs.rest.endpointUrl && credentialsFor(local, 'rest')?.secret),
    git: !!(prefs.git.repo && credentialsFor(local, 'git')?.secret)
  };

  for (const el of document.querySelectorAll('[data-backend-state]')) {
    const backend = el.dataset.backendState;
    const state = backendState(local, backend);

    if (backend !== 'browser-sync' && !configuredFor[backend]) { el.textContent = ''; continue; }
    if (!state.lastSyncAt) {
      el.textContent = configuredFor[backend] && backend !== 'browser-sync'
        ? msg('backendConfigured') : '';
      continue;
    }
    el.textContent = msg('backendLastSync', [new Date(state.lastSyncAt).toLocaleString()]);
  }
}

function refreshBackendVisibility() {
  const backend = currentBackend();
  $('config-webdav').hidden = backend !== 'webdav';
  refreshWebdavMode();
  $('config-rest').hidden = backend !== 'rest';
  $('config-git').hidden = backend !== 'git';
  $('testRow').hidden = !backend;
  refreshHistoryVisibility();
}

function refreshHistoryVisibility() {
  const available = historyAvailable(currentBackend());
  $('historyUnavailable').hidden = available;
  $('historyFields').hidden = !available;
}

function refreshFilterVisibility() {
  const mode = document.querySelector('input[name="filterMode"]:checked')?.value || 'all';
  $('filterRulesBlock').hidden = mode === 'all';
}

/**
 * Rules match on the group name and names change, so this shows what the rules
 * are actually excluding right now. A rule that has quietly stopped matching
 * anything is visible instead of silent.
 */
async function refreshFilterPreview() {
  const box = $('filterPreview');
  const mode = document.querySelector('input[name="filterMode"]:checked')?.value || 'all';
  if (mode === 'all') { box.textContent = ''; return; }

  const filter = readFilter();
  const groups = await browser.runtime.sendMessage({ type: 'current-groups' }).catch(() => []);
  const excluded = previewMatches(filter, groups || []);

  if (!excluded.length) {
    box.textContent = msg('filterMatchingNone');
    return;
  }
  box.innerHTML = '';
  box.append(document.createTextNode(msg('filterMatchingNow')));
  const ul = document.createElement('ul');
  for (const g of excluded) {
    const li = document.createElement('li');
    li.textContent = g.title || '—';
    ul.append(li);
  }
  box.append(ul);
}

function readFilter() {
  return {
    mode: document.querySelector('input[name="filterMode"]:checked')?.value || 'all',
    rules: $('filterRules').value.split('\n').map((s) => s.trim()).filter(Boolean),
    applyIncoming: $('filterIncoming').checked
  };
}

/* ---------- host permission ---------- */

/**
 * Earlier builds asked for patterns that carried the port. Firefox stored them
 * but the network layer never honoured them, so they sit in the granted list
 * doing nothing. They are cleared out once, here, rather than left to confuse
 * the permission line forever.
 */
async function dropStalePortPatterns() {
  const all = await browser.permissions.getAll().catch(() => null);
  const stale = (all?.origins || []).filter((o) => /:\d+\/\*$/.test(o));
  if (stale.length) {
    await browser.permissions.remove({ origins: stale }).catch(() => {});
  }
  return stale.length;
}

/**
 * A blocked cross-origin fetch and an unreachable server both surface as the
 * same opaque NetworkError, so the one fact that separates them — whether the
 * permission is actually held — is shown before anything is attempted.
 */
async function refreshPermissionState() {
  const line = $('webdavPermState');
  const url = $('webdavUrl').value.trim();

  if (!url) { line.textContent = ''; line.className = 'perm-line'; return; }

  let origin;
  try {
    origin = originPatternFor(url);
  } catch {
    line.className = 'perm-line is-warn';
    line.textContent = msg('permInvalidUrl');
    return;
  }

  const has = await browser.permissions.contains({ origins: [origin] });
  line.className = `perm-line is-${has ? 'ok' : 'warn'}`;
  line.textContent = msg(has ? 'permGranted' : 'permMissing', [origin]);
}

function serverUrlForBackend() {
  switch (currentBackend()) {
    case 'webdav':
      return webdavMode() === 'generic'
        ? $('davUrl').value.trim()
        : $('webdavUrl').value.trim();
    case 'rest': return $('restUrl').value.trim();
    case 'git': return $('gitBase').value.trim();
    default: return null;
  }
}

/**
 * Wraps a click handler so the permission prompt is the first thing that
 * happens. Nothing may be awaited before requestHostPermission, so the work
 * itself is chained with .then().
 */
function withHostPermission(url, statusEl, run) {
  if (!url) return;

  let request;
  try {
    request = requestHostPermission(url);
  } catch {
    return;
  }

  // The status element keeps its own base class; only the state suffix changes.
  const base = statusEl.classList[0] || 'status';
  const setState = (state, text) => {
    statusEl.className = `${base} is-${state}`;
    statusEl.textContent = text;
  };

  setState('busy', msg('testing'));

  request.then((granted) => {
    if (!granted) {
      setState('error', msg('testFailPermission'));
      return;
    }
    return Promise.resolve(run(url)).finally(refreshPermissionState);
  }).catch((e) => {
    setState('error', String(e.message || e));
  });
}

/* ---------- Nextcloud Login Flow v2 ---------- */

/**
 * The user never types their Nextcloud password here. Firefox opens the login
 * page, they authorise, and the server hands back an app password they can
 * revoke later from Settings > Security.
 */
async function connectNextcloud(serverUrl) {
  const status = $('webdavAuthStatus');
  status.className = 'status is-busy';
  status.textContent = msg('testing');

  try {
    const flow = await startLoginFlow(serverUrl);
    const tab = await browser.tabs.create({ url: flow.loginUrl });

    const result = await pollLoginFlow(flow);
    await browser.tabs.remove(tab.id).catch(() => {});

    // The 200 comes back exactly once, so this is persisted before anything
    // else can go wrong.
    const userId = await fetchUserId(result.server, result.loginName, result.appPassword);
    await setCredentials('webdav', {
      type: 'nextcloud', user: result.loginName, secret: result.appPassword
    });
    await setPrefs({ webdav: { serverUrl: result.server, userId } });

    prefs = await getPrefs();
    local = await getLocal();

    status.className = 'status is-ok';
    status.textContent = msg('connected', [result.loginName]);
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = e.code === 'unreachable'
      ? msg('testFailUnreachable')
      : msg('testFailGeneric', [String(e.message || e)]);

    // The exact URLs and failure reasons matter far more than the summary when
    // a self-hosted server will not answer.
    const box = $('webdavDiagnostics');
    box.hidden = false;
    const lines = [];
    try {
      const origin = originPatternFor(serverUrl);
      const has = await browser.permissions.contains({ origins: [origin] });
      lines.push(`host permission ${origin}: ${has ? 'granted' : 'MISSING'}`);
    } catch { /* unparseable URL, already reported above */ }
    if (e.attempts) lines.push(...e.attempts);
    else lines.push(String(e.message || e));
    box.textContent = lines.join('\n');
  }
}

/* ---------- folder picker ---------- */

/**
 * A browser for existing folders alone is useless on first run: the folder you
 * want is precisely the one that does not exist yet. So the picker shows where
 * you are, lets you take that location, and can create a subfolder in place —
 * no trip to Nextcloud and back.
 */

function parentOf(path) {
  const parent = path.replace(/\/[^/]+\/?$/, '');
  return parent || '/';
}

function joinPath(base, name) {
  return (base === '/' ? '' : base.replace(/\/+$/, '')) + '/' + name;
}

/**
 * Creating the folder is offered explicitly as well as happening on the first
 * sync, because a user who has just typed a path wants to know now that it
 * worked, not at the next sync.
 */
async function createTypedFolder() {
  const status = $('webdavAuthStatus');
  const path = $('webdavFolder').value.trim();
  if (!path) return;

  status.className = 'status is-busy';
  status.textContent = msg('encWorking');

  try {
    const adapter = new WebdavAdapter({ ...prefs.webdav, folderPath: '' }, credentialsFor(local, 'webdav'));
    await adapter.createDirectory(path);
    status.className = 'status is-ok';
    status.textContent = msg('folderCreated');
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = String(e.message || e);
  }
}

async function browseFolders(startPath) {
  if (typeof startPath !== 'string' || !startPath.startsWith('/')) startPath = '/';

  const picker = $('folderPicker');
  picker.hidden = false;
  picker.textContent = msg('testing');

  const adapter = new WebdavAdapter({ ...prefs.webdav, folderPath: '' }, credentialsFor(local, 'webdav'));

  try {
    const dirs = await adapter.listDirectories(startPath);
    renderPicker(startPath, dirs, adapter);
  } catch (e) {
    picker.innerHTML = '';
    const err = document.createElement('p');
    err.className = 'picker-error';
    err.textContent = String(e.message || e);
    picker.append(err);
  }
}

function renderPicker(path, dirs, adapter) {
  const picker = $('folderPicker');
  picker.innerHTML = '';

  // Header: where you are, and the button that takes it.
  const head = document.createElement('div');
  head.className = 'picker-head';

  const crumb = document.createElement('span');
  crumb.className = 'picker-path';
  crumb.textContent = path === '/' ? msg('pickerRoot') : path;

  const use = document.createElement('button');
  use.type = 'button';
  use.className = 'btn btn-small';
  use.textContent = msg('useThisFolder');
  use.addEventListener('click', () => {
    $('webdavFolder').value = path === '/' ? '' : path;
    picker.hidden = true;
  });

  head.append(crumb, use);
  picker.append(head);

  if (path !== '/') {
    picker.append(pickerButton('..', () => browseFolders(parentOf(path))));
  }

  for (const dir of dirs) {
    picker.append(pickerButton(dir, () => browseFolders(joinPath(path, dir))));
  }

  if (!dirs.length && path === '/') {
    const empty = document.createElement('p');
    empty.className = 'picker-empty';
    empty.textContent = '—';
    picker.append(empty);
  }

  picker.append(newFolderRow(path, adapter));
}

function newFolderRow(path, adapter) {
  const row = document.createElement('div');
  row.className = 'picker-new';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = msg('newFolderName');
  input.spellcheck = false;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-small';
  button.textContent = msg('createFolder');

  const create = async () => {
    // Slashes are allowed so a whole chain can be typed at once; the adapter
    // creates each segment in order.
    const name = input.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;

    button.disabled = true;
    try {
      const full = joinPath(path, name);
      await adapter.createDirectory(full);
      // Step into what was just created, so "Use this folder" is one click away.
      await browseFolders(full);
    } catch (e) {
      const err = document.createElement('p');
      err.className = 'picker-error';
      err.textContent = String(e.message || e);
      row.after(err);
    } finally {
      button.disabled = false;
    }
  };

  button.addEventListener('click', create);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

  row.append(input, button);
  return row;
}

function pickerButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'picker-item';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- connection test ---------- */

/**
 * The whole point: a wrong address or a revoked password shows up here, in
 * words, instead of as a sync that quietly never happens.
 */
async function testConnection() {
  const out = $('testResult');
  out.className = 'test-result is-busy';
  out.textContent = msg('testing');

  await save({ silent: true });

  try {
    const result = await browser.runtime.sendMessage({ type: 'test-connection' });
    const mapped = testResultMessage(result, currentBackend());
    out.className = `test-result is-${mapped.level}`;
    out.textContent = msg(mapped.key, mapped.detail ? [mapped.detail] : undefined);
  } catch (e) {
    out.className = 'test-result is-error';
    out.textContent = msg('testFailGeneric', [String(e.message || e)]);
  }
}

/* ---------- master password ---------- */

let keyState = 'off';

/**
 * Three states, and they must be told apart: "no password anywhere" and
 * "password set on another computer, this one has never been told" look
 * identical from the local side, so the server is asked what it holds.
 */
async function refreshKeyState() {
  const status = await browser.runtime.sendMessage({ type: 'key-status' })
    .catch(() => ({ state: 'off' }));
  keyState = status.state;

  $('encUnlockBlock').hidden = keyState !== 'locked';
  $('encSetupBlock').hidden = keyState !== 'off';
  $('encManageBlock').hidden = keyState !== 'unlocked';

  const line = $('encStateLine');
  if (keyState === 'unlocked') {
    line.className = 'state-line is-ok';
    line.textContent = msg('encStateUnlocked');
  } else if (keyState === 'locked') {
    line.className = 'state-line is-warn';
    // Four situations that look alike from the local side and are not.
    line.textContent =
      status.mismatch ? msg('encStateChangedElsewhere')
      : inSetup() ? msg('encExistingServer')
      : prefs.encryption.keyId ? msg('encStateLocked')
      : msg('encStateLockedNew');
  } else {
    line.className = 'state-line';
    line.textContent = msg('encStateOff');
  }
}

function refreshEncryptionVisibility() {
  $('encFields').hidden = !$('encEnabled').checked;
}

/** First computer: no encrypted data exists yet, so this creates the key. */
async function applyMasterPassword() {
  const status = $('encStatus');
  const a = $('encPass').value;
  const b = $('encPass2').value;

  if (!a) return;
  if (a !== b) {
    status.className = 'status is-error';
    status.textContent = msg('masterPasswordMismatch');
    return;
  }

  status.className = 'status is-busy';
  status.textContent = msg('encWorking');

  try {
    await browser.runtime.sendMessage({ type: 'unlock', passphrase: a });
    $('encPass').value = '';
    $('encPass2').value = '';
    prefs = await getPrefs();
    await refreshKeyState();
    status.className = 'status is-ok';
    status.textContent = msg('saved');

    // Setting the password is the last question of first run.
    if (inSetup()) await finishSetup();
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = String(e.message || e);
  }
}

/**
 * Second computer: derives against the salt already on the server and checks
 * the result before trusting it, so a typo says so instead of producing
 * unreadable output.
 */
async function unlockHere() {
  const status = $('unlockStatus');
  const pass = $('unlockPass').value;
  if (!pass) return;

  status.className = 'status is-busy';
  status.textContent = msg('encWorking');

  try {
    await browser.runtime.sendMessage({ type: 'unlock', passphrase: pass });
    $('unlockPass').value = '';
    prefs = await getPrefs();
    local = await getLocal();
    await refreshKeyState();
    if (inSetup()) await finishSetup();

    status.className = 'status is-ok';
    // If the credentials travelled sealed, they are now available here.
    status.textContent = credentialsFor(local, 'webdav')
      ? msg('encCredentialsRestored')
      : msg('saved');
    await load();
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = e.name === 'WrongPassphraseError' || /wrong-passphrase/.test(String(e.message))
      ? msg('masterPasswordWrong')
      : String(e.message || e);
  }
}

async function rotatePassword() {
  const status = $('rotateStatus');
  const a = $('rotatePass').value;
  const b = $('rotatePass2').value;

  if (!a) return;
  if (a !== b) {
    status.className = 'status is-error';
    status.textContent = msg('masterPasswordMismatch');
    return;
  }

  status.className = 'status is-busy';
  status.textContent = msg('encWorking');

  try {
    const result = await browser.runtime.sendMessage({ type: 'rotate-key', passphrase: a });
    $('rotatePass').value = '';
    $('rotatePass2').value = '';
    prefs = await getPrefs();
    await refreshKeyState();
    status.className = 'status is-ok';
    status.textContent = msg('encRewritten', [String(result.rewritten)]);
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = String(e.message || e);
  }
}

async function turnOffEncryption() {
  const status = $('rotateStatus');
  status.className = 'status is-busy';
  status.textContent = msg('encWorking');
  try {
    await browser.runtime.sendMessage({ type: 'disable-encryption' });
    prefs = await getPrefs();
    $('encEnabled').checked = false;
    await refreshKeyState();
    status.className = 'status is-ok';
    status.textContent = msg('saved');
  } catch (e) {
    status.className = 'status is-error';
    status.textContent = String(e.message || e);
  }
}

/* ---------- snapshot browser ---------- */

/**
 * Browsing history belongs here rather than in the popup: a snapshot holds
 * several groups, each holding several tabs, and that is three levels to walk.
 *
 * Every computer keeps its own folder of snapshots, so the picker at the top
 * lets you reach into another machine's history — which is the whole reason
 * they are stored separately.
 */

const send = (message) => browser.runtime.sendMessage(message);

async function loadDevices() {
  const select = $('historyDevice');
  const devices = await send({ type: 'list-devices' }).catch(() => []);

  const previous = select.value;
  select.innerHTML = '';
  for (const d of devices) {
    const option = document.createElement('option');
    option.value = d.name;
    // The option already carries "this computer"; a label above the list saying
    // the same thing only made it look like a filter.
    option.textContent = d.self ? `${d.name} (${msg('setupDeviceHintShort')})` : d.name;
    select.append(option);
  }
  if (previous && devices.some((d) => d.name === previous)) select.value = previous;

  // Removing the computer you are using would be nonsense, so it is offered
  // only for the others.
  const chosen = devices.find((d) => d.name === select.value);
  $('deviceRemove').hidden = !chosen || chosen.self;
  resetDeviceRemove();

  return devices;
}

async function loadSnapshots() {
  const box = $('snapshotList');
  const device = $('historyDevice').value;
  if (!device) { box.innerHTML = ''; return; }

  setSnapStatus(msg('historyLoading'));

  const snapshots = await send({ type: 'list-snapshots', device }).catch(() => []);
  if (!snapshots.length) {
    setSnapStatus(msg('historyEmpty'));
    return;
  }

  box.innerHTML = '';
  for (const snap of snapshots) {
    box.append(snapshotRow(snap));
  }
}

function setSnapStatus(text) {
  const box = $('snapshotList');
  box.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'snap-status';
  p.textContent = text;
  box.append(p);
}

function snapshotRow(snap) {
  const row = document.createElement('div');
  row.className = 'snap-row';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'snap-open';
  open.textContent = new Date(snap.takenAt).toLocaleString();
  open.addEventListener('click', () => openSnapshot(snap));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-quiet btn-small';
  remove.textContent = msg('deleteSnapshot');

  // Two presses rather than a dialog: a snapshot is somebody's session and
  // there is no undo for deleting one.
  let armed = false;
  remove.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      remove.textContent = msg('confirmOnce');
      return;
    }
    remove.disabled = true;
    await browser.runtime.sendMessage({ type: 'delete-snapshot', key: snap.key })
      .catch(() => {});
    row.remove();
  });

  row.append(open, remove);
  return row;
}

let deviceRemoveArmed = false;

function resetDeviceRemove() {
  deviceRemoveArmed = false;
  $('deviceRemove').textContent = msg('deleteDevice');
  $('deviceRemoveHint').hidden = true;
}

async function removeDevice() {
  const device = $('historyDevice').value;
  if (!device) return;

  if (!deviceRemoveArmed) {
    deviceRemoveArmed = true;
    $('deviceRemove').textContent = msg('deleteDeviceConfirm');
    $('deviceRemoveHint').hidden = false;
    return;
  }

  $('deviceRemove').disabled = true;
  try {
    await browser.runtime.sendMessage({ type: 'delete-device', device });
    await loadDevices();
    await loadSnapshots();
  } finally {
    $('deviceRemove').disabled = false;
    resetDeviceRemove();
  }
}

async function openSnapshot(snap) {
  setSnapStatus(msg('historyLoading'));

  const data = await send({ type: 'read-snapshot', key: snap.key }).catch(() => null);
  const box = $('snapshotList');
  box.innerHTML = '';

  const back = document.createElement('div');
  back.className = 'snap-row';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'snap-open';
  backBtn.textContent = `\u2190 ${msg('historyBack')}`;
  backBtn.addEventListener('click', loadSnapshots);
  back.append(backBtn);
  box.append(back);

  if (!data || !data.groups?.length) {
    const p = document.createElement('p');
    p.className = 'snap-status';
    p.textContent = msg('historyEmpty');
    box.append(p);
    return;
  }

  for (const group of data.groups) {
    box.append(groupRow(group, box));
  }
}

function groupRow(group, box) {
  const row = document.createElement('div');
  row.className = 'snap-row';

  const label = document.createElement('div');
  label.className = 'snap-label';
  const name = document.createElement('b');
  name.textContent = group.title || '—';
  const meta = document.createElement('span');
  meta.className = 'snap-meta';
  meta.textContent = msg('historyTabCount', [String(group.tabs.length)]);
  label.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'snap-actions';

  const showTabs = document.createElement('button');
  showTabs.type = 'button';
  showTabs.className = 'btn btn-quiet btn-small';
  showTabs.textContent = msg('historyShowTabs');

  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn btn-small';
  restore.textContent = msg('restoreGroup');
  restore.addEventListener('click', async () => {
    restore.disabled = true;
    // Restoring always opens a new group rather than merging into a live one:
    // recovering something must never overwrite what is currently open.
    await send({ type: 'restore-group', group }).catch(() => {});
    restore.textContent = msg('historyRestored');
  });

  actions.append(showTabs, restore);
  row.append(label, actions);

  let tabsBox = null;
  showTabs.addEventListener('click', () => {
    if (tabsBox) { tabsBox.remove(); tabsBox = null; return; }
    tabsBox = tabList(group);
    row.after(tabsBox);
  });

  return row;
}

function tabList(group) {
  const wrap = document.createElement('div');
  wrap.className = 'snap-tabs';

  for (const tab of group.tabs) {
    const line = document.createElement('div');
    line.className = 'snap-tab';

    const title = document.createElement('span');
    title.textContent = tab.title || tab.url;
    title.title = tab.url;

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn btn-quiet btn-small';
    restore.textContent = msg('restoreTab');
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      await send({ type: 'restore-tab', tab }).catch(() => {});
      restore.textContent = msg('historyRestored');
    });

    line.append(title, restore);
    wrap.append(line);
  }
  return wrap;
}

/* ---------- save ---------- */

async function save({ silent = false } = {}) {
  const backend = currentBackend();

  const patch = {
    backend,
    syncIntervalMinutes: Number($('interval').value),
    // enabled/keyId are owned by the key flow, not by this form.
    encryption: { syncCredentials: $('encSyncCreds').checked },
    history: {
      enabled: $('historyEnabled').checked,
      keepDays: Number($('historyDays').value),
      keepPerDevice: Number($('historyCount').value)
    },
    webdav: {
      mode: webdavMode(),
      serverUrl: $('webdavUrl').value.trim(),
      davUrl: $('davUrl').value.trim(),
      folderPath: $('webdavFolder').value.trim(),
      userId: prefs.webdav.userId
    },
    rest: { endpointUrl: $('restUrl').value.trim() },
    git: {
      baseUrl: $('gitBase').value.trim(),
      repo: $('gitRepo').value.trim(),
      branch: $('gitBranch').value.trim() || 'main',
      path: $('gitPath').value.trim()
    }
  };

  await setPrefs(patch);

  // The name is not saved here: changing it renames a file on the server, so it
  // has its own button rather than riding along with every other setting.
  const localPatch = { filter: readFilter() };

  // A masked field means "unchanged", not "set the password to bullets".
  await setLocal(localPatch);

  // Each destination keeps its own credentials, so switching between them never
  // hands one backend's secret to another.
  if (backend === 'webdav' && webdavMode() === 'generic') {
    const davPass = $('davPass').value;
    const davUser = $('davUser').value.trim();
    const existing = credentialsFor(local, 'webdav');
    if (davUser && davPass && !davPass.startsWith('•')) {
      await setCredentials('webdav', { type: 'basic', user: davUser, secret: davPass });
    } else if (davUser && existing) {
      await setCredentials('webdav', { ...existing, user: davUser });
    }
  }

  const restToken = $('restToken').value;
  if (backend === 'rest' && restToken && !restToken.startsWith('•')) {
    await setCredentials('rest', { type: 'bearer', user: '', secret: restToken });
  }

  const gitToken = $('gitToken').value;
  if (backend === 'git' && gitToken && !gitToken.startsWith('•')) {
    await setCredentials('git', { type: 'bearer', user: '', secret: gitToken });
  }

  prefs = await getPrefs();
  local = await getLocal();

  if (backend === 'webdav' && credentialsFor(local, 'webdav') && prefs.webdav.folderPath
      && prefs.webdav.folderPath !== lastKnownFolder) {
    lastKnownFolder = prefs.webdav.folderPath;
    try {
      const adapter = new WebdavAdapter(prefs.webdav, credentialsFor(local, 'webdav'));
      await adapter.ensureFolderPath();
    } catch {
      // Best effort: the first sync creates it too, and Test connection reports
      // properly if something is actually wrong.
    }
  }

  if (prefs.encryption.syncCredentials) {
    await browser.runtime.sendMessage({ type: 'save-credentials' }).catch(() => {});
  }

  if (!silent) {
    $('saveStatus').className = 'save-status is-ok';
    $('saveStatus').textContent = msg('saved');
    setTimeout(() => { $('saveStatus').textContent = ''; }, 2500);
  }
}

/* ---------- diagnostics ---------- */

function renderTrace() {
  const heading = $('traceHeading');
  const out = $('traceOut');
  // The trace belongs to the destination it was recorded against.
  const trace = backendState(local, currentBackend()).lastTrace;

  if (!trace || !trace.length) {
    heading.hidden = true;
    out.hidden = true;
    return;
  }

  heading.hidden = false;
  out.hidden = false;
  out.textContent = trace
    .map((t) => {
      if (t.note) return `--- ${t.note}`;
      const cond = t.ifMatch ? ` If-Match:${t.ifMatch}`
                 : t.ifNoneMatch ? ` If-None-Match:${t.ifNoneMatch}`
                 : '';
      return `${String(t.status).padEnd(4)} ${t.method.padEnd(9)} ${t.path}${cond}` +
             (t.etag ? `  ETag=${t.etag}` : '') +
             (t.error ? `  ${t.error}` : '');
    })
    .join('\n');
}

async function runDiagnostics() {
  const out = $('diagnoseOut');
  const backend = currentBackend();
  out.hidden = false;
  out.textContent = msg('testing');

  try {
    // Each destination has its own contract to walk, so each has its own probe.
    const adapter = backend === 'webdav'
      ? new WebdavAdapter(prefs.webdav, credentialsFor(local, 'webdav'))
      : backend === 'rest'
        ? new RestAdapter(prefs.rest, credentialsFor(local, 'rest'))
        : null;

    if (!adapter?.diagnose) {
      out.textContent = msg('diagnoseUnavailable');
      return;
    }

    const steps = await adapter.diagnose();
    out.textContent = steps
      .map((s) => `${String(s.status ?? 'ERR').padEnd(5)} ${s.label}` +
                  (s.etag ? `   ETag=${s.etag}` : '') +
                  (s.detail ? `\n      ${s.detail}` : '') +
                  (s.error ? `   ${s.error}` : ''))
      .join('\n');
  } catch (e) {
    out.textContent = String(e.message || e);
  }
}

/* ---------- export / import ---------- */

async function doExport() {
  const data = await exportSettings();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  // An anchor avoids needing the "downloads" permission for a one-off save.
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tab-groups-sync-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function doImport(file) {
  try {
    await importSettings(JSON.parse(await file.text()));
    await load();
    $('saveStatus').className = 'save-status is-ok';
    $('saveStatus').textContent = msg('saved');
  } catch (e) {
    $('saveStatus').className = 'save-status is-error';
    $('saveStatus').textContent = String(e.message || e);
  }
}

/* ---------- wiring ---------- */

function wire() {
  for (const r of document.querySelectorAll('input[name="backend"]')) {
    r.addEventListener('change', refreshBackendVisibility);
  }
  for (const r of document.querySelectorAll('input[name="filterMode"]')) {
    r.addEventListener('change', () => { refreshFilterVisibility(); refreshFilterPreview(); });
  }

  $('filterRules').addEventListener('input', debounce(refreshFilterPreview, 400));
  $('webdavUrl').addEventListener('input', debounce(refreshPermissionState, 300));
  for (const r of document.querySelectorAll('input[name="webdavMode"]')) {
    r.addEventListener('change', refreshWebdavMode);
  }
  $('encEnabled').addEventListener('change', refreshEncryptionVisibility);
  $('encApply').addEventListener('click', applyMasterPassword);
  $('unlockBtn').addEventListener('click', unlockHere);
  $('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockHere(); });
  $('rotateBtn').addEventListener('click', rotatePassword);
  $('encDisableBtn').addEventListener('click', turnOffEncryption);
  // permissions.request() must run synchronously inside the click handler:
  // an await before it loses the user gesture and Firefox refuses the call.
  $('webdavConnect').addEventListener('click', () => {
    withHostPermission($('webdavUrl').value.trim(), $('webdavAuthStatus'), connectNextcloud);
  });
  // Opening the server in a real tab is the only way Firefox will show a
  // certificate warning the user can accept.
  $('webdavOpenTab').addEventListener('click', () => {
    const url = $('webdavUrl').value.trim();
    if (url) browser.tabs.create({ url });
  });
  checkSetupName = wireNameField('setupName', 'setupNameFile', 'setupNameState', 'setupNameForce');
  checkAdvancedName = wireNameField('deviceName', 'deviceNameFile', 'deviceNameState');
  $('deviceRename').addEventListener('click', renameThisDevice);
  $('setupContinue').addEventListener('click', setupStepName);
  $('wizardSyncNext').addEventListener('click', setupStepDestination);
  $('wizardSkipEnc').addEventListener('click', finishSetup);
  $('historyDevice').addEventListener('change', async () => {
    await loadDevices();
    await loadSnapshots();
  });
  $('deviceRemove').addEventListener('click', removeDevice);
  $('historyRefresh').addEventListener('click', async () => {
    await loadDevices();
    await loadSnapshots();
  });
  $('webdavCreateFolder').addEventListener('click', () => {
    withHostPermission(serverUrlForBackend(), $('webdavAuthStatus'), async () => {
      await save({ silent: true });
      await createTypedFolder();
    });
  });
  $('webdavBrowse').addEventListener('click', () => {
    withHostPermission(serverUrlForBackend(), $('webdavAuthStatus'), () => browseFolders('/'));
  });
  $('testBtn').addEventListener('click', () => {
    const url = serverUrlForBackend();
    if (!url) { testConnection(); return; }
    withHostPermission(url, $('testResult'), testConnection);
  });
  $('saveBtn').addEventListener('click', () => save());
  $('diagnoseBtn').addEventListener('click', () => {
    withHostPermission(serverUrlForBackend(), $('saveStatus'), runDiagnostics);
  });
  $('exportBtn').addEventListener('click', doExport);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) doImport(e.target.files[0]);
  });
  $('resetBtn').addEventListener('click', async () => {
    await browser.storage.local.clear();
    await browser.storage.sync.clear();
    location.reload();
  });

  // Another computer may change a preference while this page is open.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.prefs) load();
  });
}

async function refreshHistoryBrowser() {
  if (!historyAvailable(currentBackend())) return;
  await loadDevices();
  await loadSnapshots();
}

function suggestedName() {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Linux')) return 'Linux';
  return 'Firefox';
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

localise();
setupNav();
wire();
load().then(refreshWizard);
