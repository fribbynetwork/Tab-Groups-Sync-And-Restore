/**
 * Settings live in two places on purpose.
 *
 * storage.sync  — preferences that should follow the user to a new computer.
 *                 Firefox Sync carries them end-to-end encrypted, and they are
 *                 small enough not to matter against the 100 KB quota.
 *
 * storage.local — anything secret (the Nextcloud app password), anything that
 *                 is per-computer by definition (device id, group filter), and
 *                 caches. Credentials are kept out of sync so they do not end up
 *                 in cleartext in the profile of every device on the account.
 */

const SYNC_KEY = 'prefs';
const LOCAL_KEY = 'local';

export const BACKENDS = ['browser-sync', 'webdav', 'rest', 'git'];

/** Firefox Sync is the no-setup tier; history is the reward for bringing a server. */
export const BACKEND_CAPABILITIES = {
  'browser-sync': { history: false, maxBytes: 100 * 1024 },
  webdav: { history: true, maxBytes: null },
  rest: { history: true, maxBytes: null },
  git: { history: true, maxBytes: null }
};

export const DEFAULT_PREFS = {
  schema: 1,
  backend: null,                 // null until the user picks one
  syncIntervalMinutes: 15,

  encryption: {
    enabled: false,
    keyId: null,
    syncCredentials: false,
    // Sealed with the master password when the user opts in, so a new computer
    // can pick up the server credentials after unlocking.
    credentialsBlob: null
  },

  history: {
    enabled: true,
    keepDays: 14,
    keepPerDevice: 25
  },

  webdav: {
    mode: 'nextcloud',     // 'nextcloud' | 'generic'
    serverUrl: '',
    davUrl: '',           // generic mode only: the full collection address
    folderPath: '/Apps/TabGroupsSync',
    userId: ''
  },
  rest: { endpointUrl: '' },
  git: { baseUrl: 'https://api.github.com', repo: '', branch: 'main', path: 'tab-groups' }
};

export const DEFAULT_LOCAL = {
  schema: 1,
  // The name IS the identity: it names the file. Reinstalling and typing the
  // same name resumes the same file instead of leaving a ghost behind.
  deviceName: '',
  // Distinguishes "this computer, reinstalled" from "someone else who picked
  // the same name".
  installId: null,

  // One entry per backend. A single shared slot meant that switching from
  // Nextcloud to a custom endpoint sent the Nextcloud app password as the
  // endpoint's bearer token, which the endpoint correctly rejected.
  credentialsByBackend: {},      // backend -> { type, user, secret }
  credentials: null,             // legacy single slot, migrated on read

  // Per-computer by design: if this were synced it would be identical
  // everywhere, which defeats the point of having different groups per machine.
  filter: {
    mode: 'all',                 // 'all' | 'exclude' | 'include'
    rules: [],                   // group names, one per entry
    applyIncoming: false
  },

  // False until the first-run questions are answered. Device name and
  // encryption are asked before any sync, because deciding them afterwards
  // means rewriting everything already on the server.
  setupDone: false,
  // Which step of first run we are on: 'name', 'destination', 'encryption'.
  // The wizard walks the real panels rather than duplicating them, so there is
  // exactly one place that ever asks for the master password.
  setupStep: 'name',

  // Sync state, one entry per destination. It has to be per destination:
  // "what I last wrote" and "what I have acknowledged from the others" mean
  // nothing when carried from one server to another.
  backendState: {},              // backend -> BACKEND_STATE

  groupIdMap: {},                // uuid -> live groupId, rebuilt every startup
  // uuid -> fingerprint, so a group keeps its identity across a restart even
  // where the session API is unavailable.
  groupPrints: {},
  faviconCache: {}               // origin -> favIconUrl
};

/** Everything that is true of one destination and meaningless for another. */
export const DEFAULT_BACKEND_STATE = {
  // Fingerprint of the session as last written, so an unchanged session is not
  // rewritten every few minutes.
  lastSignature: null,
  // What this computer last acknowledged from each other device. Acknowledging
  // is explicit, so the same change is never offered twice.
  seenDevices: {},
  // Devices whose file is newer than the acknowledgement, awaiting a decision.
  pendingDevices: [],
  // Computers whose files are sealed with a different password: visible in the
  // list, but nothing here can open them.
  unreadableDevices: [],
  lastSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  lastTrace: null,
  pendingRemote: 0
};

export function backendState(local, backend) {
  return { ...DEFAULT_BACKEND_STATE, ...(local.backendState?.[backend] || {}) };
}

export async function setBackendState(backend, patch) {
  const local = await getLocal();
  const next = { ...backendState(local, backend), ...patch };
  return setLocal({ backendState: { ...local.backendState, [backend]: next } });
}

function merge(defaults, stored) {
  if (!stored) return structuredClone(defaults);
  const out = structuredClone(defaults);
  for (const [k, v] of Object.entries(stored)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && out[k])
      ? { ...out[k], ...v }
      : v;
  }
  return out;
}

export async function getPrefs() {
  const stored = await browser.storage.sync.get(SYNC_KEY);
  return merge(DEFAULT_PREFS, stored[SYNC_KEY]);
}

export async function setPrefs(patch) {
  const current = await getPrefs();
  const next = merge(current, patch);
  await browser.storage.sync.set({ [SYNC_KEY]: next });
  return next;
}

export async function getLocal() {
  const stored = await browser.storage.local.get(LOCAL_KEY);
  const local = merge(DEFAULT_LOCAL, stored[LOCAL_KEY]);

  // Anything stored before credentials were split per backend came from the
  // Nextcloud login flow, which was the only thing that wrote them.
  if (local.credentials && !Object.keys(local.credentialsByBackend).length) {
    local.credentialsByBackend = { webdav: local.credentials };
    local.credentials = null;
    await browser.storage.local.set({ [LOCAL_KEY]: local });
  }

  if (!local.installId) {
    local.installId = crypto.randomUUID();
    await browser.storage.local.set({ [LOCAL_KEY]: local });
  }
  return local;
}

export function credentialsFor(local, backend) {
  return local.credentialsByBackend?.[backend] || null;
}

export async function setCredentials(backend, credentials) {
  const local = await getLocal();
  return setLocal({
    credentialsByBackend: { ...local.credentialsByBackend, [backend]: credentials }
  });
}

export async function setLocal(patch) {
  const current = await getLocal();
  const next = merge(current, patch);
  await browser.storage.local.set({ [LOCAL_KEY]: next });
  return next;
}

/**
 * There is no API for the machine's name, so a suggestion is derived from the
 * platform. It has to be a valid filename, so no spaces.
 */
export function suggestedDeviceName() {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Linux')) return 'Linux';
  return 'Firefox';
}

export async function isConfigured() {
  const prefs = await getPrefs();
  if (!prefs.backend) return false;
  if (prefs.backend === 'browser-sync') return true;

  const local = await getLocal();
  if (!local.deviceName) return false;
  const creds = credentialsFor(local, prefs.backend);

  if (prefs.backend === 'webdav') {
    const base = prefs.webdav.mode === 'generic' ? prefs.webdav.davUrl : prefs.webdav.serverUrl;
    return !!(base && creds);
  }
  if (prefs.backend === 'rest') return !!(prefs.rest.endpointUrl && creds?.secret);
  if (prefs.backend === 'git') return !!(prefs.git.repo && creds?.secret);
  return false;
}

export function historyAvailable(backend) {
  return !!BACKEND_CAPABILITIES[backend]?.history;
}

/* ---------- settings export / import ---------- */

/**
 * For people who deliberately do not use a Mozilla account: without this they
 * would have to retype the server settings on every computer.
 */
export async function exportSettings() {
  const prefs = await getPrefs();
  const local = await getLocal();
  return {
    format: 'tgsr-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    prefs,
    filter: local.filter
    // credentials are deliberately left out of the plain export
  };
}

export async function importSettings(payload) {
  if (payload?.format !== 'tgsr-settings') {
    throw new Error('not-a-settings-file');
  }
  await setPrefs(payload.prefs || {});
  if (payload.filter) await setLocal({ filter: payload.filter });
}
