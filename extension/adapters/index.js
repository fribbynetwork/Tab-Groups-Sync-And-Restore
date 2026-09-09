import { BrowserSyncAdapter } from './browser-sync.js';
import { WebdavAdapter } from './webdav.js';
import { RestAdapter } from './rest.js';
import { GitAdapter } from './git.js';
import { getPrefs, getLocal, credentialsFor } from '../lib/config.js';

export { ConflictError, AuthError, NotFoundError, NetworkError, PermissionError,
         requestHostPermission, originPatternFor } from './base.js';
export { startLoginFlow, pollLoginFlow, fetchUserId, WebdavAdapter } from './webdav.js';
export { RestAdapter } from './rest.js';

export async function createAdapter(prefsOverride, localOverride) {
  const prefs = prefsOverride || await getPrefs();
  const local = localOverride || await getLocal();

  // Each backend gets its own credentials; sharing one slot meant handing a
  // Nextcloud app password to a REST endpoint expecting a bearer token.
  const creds = credentialsFor(local, prefs.backend);

  switch (prefs.backend) {
    case 'browser-sync': return new BrowserSyncAdapter();
    case 'webdav': return new WebdavAdapter(prefs.webdav, creds);
    case 'rest': return new RestAdapter(prefs.rest, creds);
    case 'git': return new GitAdapter(prefs.git, creds);
    default: return null;
  }
}

/**
 * Turns a test() result into the message key the Settings page shows. The point
 * of "Test connection" is that the user finds out what is wrong now, in words
 * they can act on, instead of discovering it through a sync that quietly never
 * happened.
 */
export function testResultMessage(result, backend) {
  if (result.ok) {
    // A working connection with no usable concurrency control is worth calling
    // out: it is the one assumption the whole conflict handling rests on.
    const keys = {
      okCreated: 'testOkCreated',
      okNoEtag: 'testOkNoEtag',
      okNoIfMatch: 'testOkNoIfMatch',
      okBrokenEtag: 'testOkBrokenEtag'
    };
    const key = keys[result.code] || 'testOk';
    const degraded = ['okNoEtag', 'okNoIfMatch', 'okBrokenEtag'];
    const level = degraded.includes(result.code) ? 'warn' : 'ok';
    return { level, key, detail: result.detail };
  }
  switch (result.code) {
    case 'noCredentials': return { level: 'error', key: 'testFailNoCredentials' };
    case 'auth':
      // "Reconnect for a new app password" only makes sense for Nextcloud.
      return {
        level: 'error',
        key: backend === 'webdav' ? 'testFailAuth' : 'testFailAuthToken'
      };
    case 'notFound': return { level: 'error', key: 'testFailNotFound' };
    case 'network': return { level: 'error', key: 'testFailNetwork' };
    case 'permission': return { level: 'error', key: 'testFailPermission' };
    default: return { level: 'error', key: 'testFailGeneric', detail: result.detail };
  }
}
