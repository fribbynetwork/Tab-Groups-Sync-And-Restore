import { prefixHistory } from '../lib/schema.js';
import { listDevices, readDeviceFile, writeDeviceFile, groupsOf } from './device-file.js';
import { seal, unseal, createMasterKey, unlockMasterKey, isUnlocked, clearKey, canOpen }
  from '../lib/crypto.js';
import { getPrefs, setPrefs, getLocal, isConfigured, credentialsFor, setCredentials }
  from '../lib/config.js';
import { createAdapter } from '../adapters/index.js';

/**
 * Everything around the master password that is not plain encryption:
 * finding out what the server is encrypted with, unlocking against it,
 * changing the password, and carrying the server credentials to a new computer.
 */

/**
 * Reads the envelope header of index.json without decrypting anything.
 *
 * This is what makes unlocking on a second computer possible at all: the salt
 * and the verifier live in cleartext in the header, so a machine that has never
 * seen the passphrase can still derive the right key from it and check the
 * result before trusting it.
 */
export async function probeRemote() {
  if (!(await isConfigured())) return { reachable: false };

  const local = await getLocal();
  const adapter = await createAdapter();

  let devices;
  try {
    devices = await listDevices(adapter, { selfName: local.deviceName });
  } catch (e) {
    return { reachable: false, error: e.name };
  }

  if (!devices.length) return { reachable: true, exists: false, encrypted: false };

  const sealed = devices.filter((d) => d.encrypted);
  if (!sealed.length) return { reachable: true, exists: true, encrypted: false };

  // Prefer a file this computer's key can actually open. Picking the most
  // recent one instead meant that a newly added computer, which had derived its
  // own key, made every other machine announce that the password had changed —
  // while their own files were perfectly readable.
  let preferred = sealed[0];
  for (const d of sealed) {
    if (await canOpen(d.envelope)) { preferred = d; break; }
  }

  // The KDF parameters live in the cleartext header of every sealed file, so a
  // computer that has never seen the passphrase can still derive the right key.
  // There is no shared file to read them from, and none is needed.
  const file = await readDeviceFile(adapter, preferred.name);

  return {
    reachable: true,
    exists: true,
    encrypted: true,
    keyId: file.keyId || null,
    // Every key id present, so "some computer uses a different password" can be
    // told apart from "the password changed".
    keyIds: [...new Set(sealed.map((d) => d.keyId).filter(Boolean))],
    // Established by attempting the verifier, not by comparing identifiers.
    readableHere: await canOpen(preferred.envelope),
    foreign: (await Promise.all(
      sealed.map(async (d) => (await canOpen(d.envelope)) ? null : d.name)
    )).filter(Boolean),
    envelope: { keyId: file.keyId, kdf: file.kdf, verifier: file.verifier }
  };
}

/**
 * Second computer: derive the key from the passphrase and the salt found in
 * another computer's file header, and check it against the verifier before
 * trusting it, so a typo says so instead of producing unreadable output.
 */
export async function unlockAgainstRemote(passphrase) {
  const probe = await probeRemote();

  // Without a reachable backend we cannot tell "nothing is encrypted yet" from
  // "encrypted, but this computer has never been told". Guessing mints a fresh
  // salt and locks the machine out of data that already exists.
  if (!probe.reachable) {
    throw Object.assign(new Error('backend-not-configured'), { name: 'NoBackendError' });
  }

  if (!probe.encrypted) {
    const keyId = await createMasterKey(passphrase);
    await setPrefs({ encryption: { enabled: true, keyId } });
    const rewritten = probe.exists ? await reEncryptAll() : 0;
    return { keyId, created: true, rewritten };
  }

  // Any key already held came from a different salt; it has to go first.
  await clearKey();
  const keyId = await unlockMasterKey(passphrase, probe.envelope);
  await setPrefs({ encryption: { enabled: true, keyId } });
  await restoreCredentials();
  return { keyId, created: false };
}

/**
 * Changing the password rewrites everything under a new salt. It happens while
 * the old key is still loaded, so the decryption is done before the swap.
 */
export async function rotateAndReEncrypt(newPassphrase) {
  if (!(await isUnlocked())) throw new Error('locked');

  const local = await getLocal();
  const adapter = await createAdapter();
  const devices = await listDevices(adapter, { selfName: local.deviceName });

  // Read everything with the key we still have.
  const decoded = [];
  for (const device of devices) {
    const file = await readDeviceFile(adapter, device.name).catch(() => null);
    if (!file) continue;
    try {
      decoded.push({ name: device.name, installId: file.installId, groups: await groupsOf(file) });
    } catch { /* not ours to rewrite */ }
  }

  await clearKey();
  const keyId = await createMasterKey(newPassphrase);

  for (const d of decoded) {
    await writeDeviceFile(adapter, d.name, d.groups, {
      encrypted: true,
      installId: d.installId || local.installId
    });
  }

  await setPrefs({ encryption: { enabled: true, keyId } });
  await saveCredentials();

  // Snapshots keep the old key id and stay readable only with the old
  // password; they age out rather than being rewritten.
  return { rewritten: decoded.length, keyId };
}

/** Rewrites every device file, and the snapshots, under the current key. */
export async function reEncryptAll() {
  return rewriteAll(true);
}

/** Turning encryption off means rewriting the same files in the clear. */
export async function disableEncryption() {
  await rewriteAll(false);
  await clearKey();
  await setPrefs({ encryption: { enabled: false, keyId: null, credentialsBlob: null } });
}

/**
 * Rewrites everything, in both directions.
 *
 * Only this computer's own file would strictly need it, but a half-encrypted
 * folder is worse than either state: the others would keep writing in the old
 * mode until they noticed, and snapshots left sealed under a discarded key are
 * lost silently.
 */
async function rewriteAll(encrypted) {
  const local = await getLocal();
  const adapter = await createAdapter();
  const devices = await listDevices(adapter, { selfName: local.deviceName });
  let count = 0;

  for (const device of devices) {
    const file = await readDeviceFile(adapter, device.name).catch(() => null);
    if (!file) continue;
    try {
      const groups = await groupsOf(file);
      await writeDeviceFile(adapter, device.name, groups, {
        encrypted,
        installId: file.installId || local.installId
      });
      count++;
    } catch {
      // Sealed with a key we do not hold: it cannot be rewritten, and it ages
      // out on its own.
    }
    await rewriteSnapshots(adapter, device.name, encrypted);
  }
  return count;
}

async function rewriteSnapshots(adapter, deviceName, encrypted) {
  const entries = await adapter.list(prefixHistory(deviceName)).catch(() => []);
  for (const entry of entries) {
    const file = await adapter.read(entry.key).catch(() => null);
    if (!file) continue;
    try {
      const snapshot = await unseal(file.data);
      await adapter.write(entry.key, await seal(snapshot, { encrypted }), file.etag ?? undefined);
    } catch { /* not readable with the current key */ }
  }
}

/* ---------- credentials carried across computers ---------- */

/**
 * Off by default. The app password is normally kept out of storage.sync so it
 * does not land in cleartext in the profile of every device on the account —
 * but sealed with the master password it is only readable by someone who
 * already knows that password, so it is a fair trade for one less setup step.
 */
export async function saveCredentials() {
  const prefs = await getPrefs();
  if (!prefs.encryption.enabled || !prefs.encryption.syncCredentials) return false;

  const local = await getLocal();
  const creds = credentialsFor(local, prefs.backend);
  if (!creds) return false;

  const blob = await seal({ backend: prefs.backend, credentials: creds }, { encrypted: true });
  await setPrefs({ encryption: { credentialsBlob: blob } });
  return true;
}

/** Runs right after a successful unlock on a computer with no credentials yet. */
export async function restoreCredentials() {
  const prefs = await getPrefs();
  const local = await getLocal();

  if (credentialsFor(local, prefs.backend)) return false;
  if (!prefs.encryption.credentialsBlob) return false;

  try {
    const payload = await unseal(prefs.encryption.credentialsBlob);
    if (payload.backend !== prefs.backend) return false;
    await setCredentials(payload.backend, payload.credentials);
    return true;
  } catch {
    // Sealed with a different password; the user connects again instead.
    return false;
  }
}

/**
 * What the Settings and popup show. Three states, and they need to be
 * distinguished properly: "no password yet" and "password set elsewhere, this
 * computer has not been told" look identical from the local side alone.
 */
export async function keyStatus() {
  const prefs = await getPrefs();
  const unlocked = await isUnlocked();
  const probe = await probeRemote().catch(() => ({ reachable: false, encrypted: false }));

  if (!prefs.encryption.enabled && !unlocked) {
    return probe.encrypted ? { state: 'locked', keyId: probe.keyId } : { state: 'off' };
  }

  if (unlocked) {
    // The question is not "does the newest file match my key" but "can I read
    // anything at all". A computer whose own file opens fine is not locked out
    // just because a newcomer arrived with a different key.
    // Locked means "I cannot read anything out there", which is a question with
    // a definite answer rather than an inference from key ids.
    if (probe.encrypted && probe.readableHere === false) {
      return { state: 'locked', keyId: probe.keyId, mismatch: true };
    }

    return {
      state: 'unlocked',
      keyId: prefs.encryption.keyId,
      // Readable here, but these computers used a different password. Worth
      // saying, and not the same thing as being locked out.
      foreign: probe.foreign || []
    };
  }

  return { state: 'locked', keyId: prefs.encryption.keyId };
}
