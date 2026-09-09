import {
  SCHEMA_VERSION, keyDevice, deviceNameFromKey, makeDeviceBody
} from '../lib/schema.js';
import { seal, unseal } from '../lib/crypto.js';

/**
 * Reading and writing the per-device files.
 *
 * Every file carries a cleartext header and a body that may be sealed. The
 * header is what makes the rest work without a shared index: it holds the
 * device name, when it was last written, and the encryption parameters, so any
 * computer can enumerate the others and derive the key without a file that
 * everyone has to write to.
 */

/**
 * @param {string} name
 * @param {object[]} groups
 * @param {{encrypted: boolean, installId: string}} opts
 */
export async function writeDeviceFile(adapter, name, groups, { encrypted, installId }) {
  const sealed = await seal(makeDeviceBody(groups), { encrypted });

  const file = {
    ...sealed,
    schema: SCHEMA_VERSION,
    device: name,
    // Distinguishes "this computer, reinstalled" from "a different computer
    // that happens to have picked the same name".
    installId,
    updatedAt: Date.now()
  };

  // No precondition: nobody else writes this file, so there is nothing to lose
  // a race against. That is the whole point of the layout.
  await adapter.write(keyDevice(name), file, undefined);
  return file;
}

export async function readDeviceFile(adapter, name) {
  const result = await adapter.read(keyDevice(name));
  if (!result) return null;
  return { ...result.data, etag: result.etag };
}

/** Header only — no decryption, so it works while locked. */
export function headerOf(file) {
  return {
    device: file.device,
    installId: file.installId || null,
    updatedAt: file.updatedAt || 0,
    encrypted: file.enc === 'AES-GCM',
    keyId: file.keyId || null,
    schema: file.schema || 1,
    // Kept so readability can be tested for real rather than inferred from the
    // key id, which is a proxy that has already been wrong once.
    envelope: { enc: file.enc, keyId: file.keyId, verifier: file.verifier }
  };
}

export async function groupsOf(file) {
  const body = await unseal(file);
  return body?.groups || [];
}

/**
 * Every computer that has ever written here, newest first.
 *
 * The folder listing is the register of devices; there is no file to keep in
 * step with it, so a device that is deleted simply stops being listed.
 */
export async function listDevices(adapter, { includeSelf = true, selfName = null } = {}) {
  const entries = await adapter.list('').catch(() => []);
  const out = [];

  for (const entry of entries) {
    const name = deviceNameFromKey(entry.key);
    if (!name) continue;
    if (!includeSelf && name === selfName) continue;

    const file = await adapter.read(entry.key).catch(() => null);
    if (!file?.data) continue;

    const header = headerOf(file.data);
    if (header.schema !== SCHEMA_VERSION) continue;
    out.push({ ...header, name, self: name === selfName });
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDeviceFile(adapter, name) {
  await adapter.remove(keyDevice(name)).catch(() => {});
}
