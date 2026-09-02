/**
 * Encryption at rest for the things Stash stores on someone else's disk.
 *
 * The web equivalent of SanFeedBin's `EncryptedPrefsBackend` (docs/EXTRACTION.md): the
 * only values this app persists outside its own environment are publisher session
 * cookies, which are bearer credentials for the reader's subscriptions. They go into a
 * hosted key-value store, so the hosting provider must never hold the plaintext.
 *
 * AES-256-GCM via WebCrypto — present unprefixed in Node 20+, in Vercel's Node and Edge
 * runtimes, and in Cloudflare Workers, which is the whole reason not to reach for
 * `node:crypto` here.
 *
 * Two decisions worth keeping:
 *
 * - **A version byte leads every blob.** Not because there is a second format today,
 *   but because there is no way to add one later to a blob that does not say what it
 *   is: the choice is one byte now or a store you cannot re-encrypt.
 * - **A blob that will not decrypt is `CorruptBlobError`, never a crash.** The store
 *   above deletes and recreates. A key rotation, a truncated write or a value someone
 *   pasted in by hand must not make the settings screen unreachable — which is exactly
 *   what an exception thrown out of a list operation would do.
 */

/** Version 1: `01 || 12-byte IV || ciphertext+tag`, base64. */
const VERSION = 1;
const IV_BYTES = 12;
/** AES-256. The key is 32 bytes however it was spelled in the environment. */
const KEY_BYTES = 32;

/** A blob that cannot be decrypted: wrong key, wrong format, or damaged. */
export class CorruptBlobError extends Error {}

/** The key is missing or unusable. An operator problem, never a caller's. */
export class EncryptionKeyError extends Error {}

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * base64 without `node:buffer`, so this runs on an edge runtime too.
 *
 * Chunked: `String.fromCharCode(...bytes)` on a long value blows the argument limit,
 * and a session header is long by nature.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Read a 32-byte key out of whatever form the environment variable is in.
 *
 * Three spellings are accepted because all three are what a person actually produces:
 * `openssl rand -base64 32`, `openssl rand -hex 32`, and a 32-character passphrase
 * typed by hand. Anything else is refused rather than stretched or padded — a key
 * silently derived from a too-short string is a key nobody knows the strength of.
 */
export function parseKeyMaterial(raw: string): Uint8Array {
  const value = raw.trim();
  if (value === '') throw new EncryptionKeyError('STASH_ENCRYPTION_KEY is empty');

  if (/^[0-9a-f]{64}$/i.test(value)) {
    const bytes = new Uint8Array(KEY_BYTES);
    for (let i = 0; i < KEY_BYTES; i += 1)
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && value.length >= 43) {
    let decoded: Uint8Array;
    try {
      // base64url is what a lot of key generators emit; the two alphabets differ in
      // two characters and nothing else.
      decoded = fromBase64(value.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      decoded = new Uint8Array(0);
    }
    if (decoded.length === KEY_BYTES) return decoded;
  }

  const utf8 = toBytes(value);
  if (utf8.length === KEY_BYTES) return utf8;

  throw new EncryptionKeyError(
    `STASH_ENCRYPTION_KEY must be 32 bytes: 64 hex characters, base64 of 32 bytes, or exactly 32 characters (got ${utf8.length} bytes). Generate one with: openssl rand -base64 32`,
  );
}

/**
 * Import a key for AES-GCM.
 *
 * `extractable: false` on purpose. Nothing here needs the bytes back, and a
 * non-extractable key cannot be read out of a crash dump or a stray log line.
 */
export async function importKey(raw: string): Promise<CryptoKey> {
  const material = parseKeyMaterial(raw);
  if (globalThis.crypto?.subtle === undefined) {
    throw new EncryptionKeyError('WebCrypto is not available in this runtime');
  }
  return globalThis.crypto.subtle.importKey('raw', material as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a string. A fresh random IV every time — GCM's one absolute rule is that an
 * IV is never reused under the same key, and the only way to keep that rule without
 * state is to draw twelve random bytes per write.
 */
export async function seal(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      toBytes(plaintext) as BufferSource,
    ),
  );

  const blob = new Uint8Array(1 + iv.length + ciphertext.length);
  blob[0] = VERSION;
  blob.set(iv, 1);
  blob.set(ciphertext, 1 + iv.length);
  return toBase64(blob);
}

/**
 * Decrypt a string, or throw `CorruptBlobError`.
 *
 * Every failure is the same error on purpose. A caller cannot do anything different
 * about a bad version byte than about a failed tag check — in both cases the value is
 * gone and the answer is to delete it and ask for a new one.
 */
export async function open(blob: string, key: CryptoKey): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(blob.trim());
  } catch {
    throw new CorruptBlobError('not base64');
  }

  if (bytes.length < 1 + IV_BYTES + 1) throw new CorruptBlobError('too short to be a blob');
  if (bytes[0] !== VERSION) throw new CorruptBlobError(`unknown blob version ${String(bytes[0])}`);

  const iv = bytes.subarray(1, 1 + IV_BYTES);
  const ciphertext = bytes.subarray(1 + IV_BYTES);

  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return fromBytes(new Uint8Array(plain));
  } catch {
    // Authentication failed: a different key, or the bytes were altered. GCM cannot
    // tell those apart and neither should this message.
    throw new CorruptBlobError('could not be decrypted with this key');
  }
}
