/**
 * Optional end-to-end encryption.
 *
 * The passphrase is never stored. It is stretched with PBKDF2 into a
 * non-extractable AES-GCM CryptoKey, which is kept in IndexedDB — storage.local
 * cannot hold a CryptoKey because it serialises to JSON, while IndexedDB uses
 * structured clone and can. So the key material never exists in cleartext in
 * storage, and the user is asked for the passphrase only once per install.
 *
 * The salt travels inside the envelope in cleartext: without it two computers
 * would derive different keys from the same passphrase.
 */

const DB_NAME = 'tgsr-keys';
const DB_STORE = 'keys';
const KEY_RECORD = 'master';

export const KDF = {
  alg: 'PBKDF2-SHA256',
  iterations: 600000,
  saltBytes: 16
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export class WrongPassphraseError extends Error {
  constructor() { super('wrong-passphrase'); this.name = 'WrongPassphraseError'; }
}
export class LockedError extends Error {
  constructor() { super('locked'); this.name = 'LockedError'; }
}

/* ---------- base64 helpers ---------- */

export function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/* ---------- IndexedDB key store ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbOp(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function storeKey(record) {
  await dbOp('readwrite', (s) => s.put(record, KEY_RECORD));
}

async function loadKey() {
  return dbOp('readonly', (s) => s.get(KEY_RECORD));
}

export async function clearKey() {
  await dbOp('readwrite', (s) => s.delete(KEY_RECORD));
}

/* ---------- derivation ---------- */

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,                       // non-extractable: cannot be read back out
    ['encrypt', 'decrypt']
  );
}

/**
 * keyId names the derivation, so a computer holding a different key can say so
 * instead of failing with a cryptic decryption error.
 *
 * It must be deterministic, and the previous version was not: it encrypted a
 * probe value with a random IV, so the same passphrase and the same salt gave a
 * different id every time it was computed. Comparing those ids proved nothing,
 * and two machines sharing a working key were told they had different ones.
 *
 * Salt and iteration count are exactly what decides the key for a given
 * passphrase, and neither reveals anything about it.
 */
async function computeKeyId(_key, salt, iterations) {
  const material = concat(
    salt,
    new TextEncoder().encode(`|${iterations}|tgsr-key-id`)
  );
  const digest = await crypto.subtle.digest('SHA-256', material);
  return b64encode(digest.slice(0, 12));
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength; }
  return out;
}

/* ---------- session state ---------- */

let cached = null;   // { key, salt, iterations, keyId }

export async function isUnlocked() {
  if (cached) return true;
  const rec = await loadKey();
  if (!rec) return false;
  cached = rec;
  return true;
}

export async function getKeyParams() {
  if (!(await isUnlocked())) return null;
  return {
    salt: b64encode(cached.salt),
    iterations: cached.iterations,
    keyId: cached.keyId
  };
}

/**
 * First setup on the first computer: generates a fresh salt.
 */
export async function createMasterKey(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(KDF.saltBytes));
  const key = await deriveKey(passphrase, salt, KDF.iterations);
  const keyId = await computeKeyId(key, salt, KDF.iterations);
  cached = { key, salt, iterations: KDF.iterations, keyId };
  await storeKey(cached);
  return keyId;
}

/**
 * Unlock on a second computer, using the salt and verifier found in the
 * envelope already on the server. Throws WrongPassphraseError so the UI can say
 * something useful rather than surfacing a GCM failure.
 */
export async function unlockMasterKey(passphrase, envelope) {
  const salt = b64decode(envelope.kdf.salt);
  const iterations = envelope.kdf.iterations || KDF.iterations;
  const key = await deriveKey(passphrase, salt, iterations);

  try {
    await decryptRaw(key, envelope.verifier.iv, envelope.verifier.body);
  } catch {
    throw new WrongPassphraseError();
  }

  // Recomputed rather than copied from the envelope: it is derived from the
  // same salt and iteration count, so it matches, and a file written by an
  // older build with a random id does not poison this computer's state.
  const keyId = await computeKeyId(key, salt, iterations);
  cached = { key, salt, iterations, keyId };
  await storeKey(cached);
  return keyId;
}

/* ---------- primitives ---------- */

async function encryptRaw(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: b64encode(iv), body: b64encode(ct) };
}

async function decryptRaw(key, ivB64, bodyB64) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64) }, key, b64decode(bodyB64)
  );
  return new Uint8Array(pt);
}

/* ---------- envelope ---------- */

/**
 * Every file written to a backend is an envelope. The header stays in cleartext
 * so a computer can read the schema version, the key id and the KDF parameters
 * without being able to decrypt anything.
 */
export async function seal(data, { encrypted }) {
  const json = JSON.stringify(data);

  if (!encrypted) {
    return { schema: 1, enc: 'none', body: json };
  }
  if (!(await isUnlocked())) throw new LockedError();

  const { key, salt, iterations, keyId } = cached;
  const payload = await encryptRaw(key, enc.encode(json));
  const verifier = await encryptRaw(key, enc.encode('tgsr-verifier'));

  return {
    schema: 1,
    enc: 'AES-GCM',
    keyId,
    kdf: { alg: KDF.alg, iterations, salt: b64encode(salt) },
    verifier,
    iv: payload.iv,
    body: payload.body
  };
}

export async function unseal(envelope) {
  if (!envelope) return null;
  if (envelope.enc === 'none') return JSON.parse(envelope.body);
  if (!(await isUnlocked())) throw new LockedError();
  if (envelope.keyId && envelope.keyId !== cached.keyId) throw new WrongPassphraseError();

  const bytes = await decryptRaw(cached.key, envelope.iv, envelope.body);
  return JSON.parse(dec.decode(bytes));
}

/**
 * Whether the key held here actually opens this envelope.
 *
 * The honest question, and cheap to ask: the verifier is a few bytes sealed
 * with the same key as the body. Comparing key ids is a proxy for this, and a
 * proxy that has already been wrong once.
 */
export async function canOpen(envelope) {
  if (!envelope || envelope.enc !== 'AES-GCM') return true;
  if (!(await isUnlocked())) return false;
  if (!envelope.verifier) return envelope.keyId === cached.keyId;

  try {
    await decryptRaw(cached.key, envelope.verifier.iv, envelope.verifier.body);
    return true;
  } catch {
    return false;
  }
}

/** Changing the passphrase means re-sealing everything under a new salt. */
export async function rotateMasterKey(newPassphrase) {
  await clearKey();
  cached = null;
  return createMasterKey(newPassphrase);
}

export async function lock() {
  cached = null;
  await clearKey();
}
