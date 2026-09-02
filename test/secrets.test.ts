import { describe, expect, it } from 'vitest';

import {
  CorruptBlobError,
  EncryptionKeyError,
  importKey,
  open,
  parseKeyMaterial,
  seal,
} from '../src/lib/secrets';

/** 32 bytes, in each of the three spellings a person actually produces. */
const HEX = 'a'.repeat(64);
const B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const PLAIN = 'x'.repeat(32);

describe('parseKeyMaterial', () => {
  it('accepts 64 hex characters', () => {
    expect(parseKeyMaterial(HEX)).toHaveLength(32);
    expect(parseKeyMaterial(HEX)[0]).toBe(0xaa);
  });

  it('accepts base64 of 32 bytes, in either alphabet', () => {
    expect(parseKeyMaterial(B64)).toHaveLength(32);
    const urlSafe = B64.replace(/\+/g, '-').replace(/\//g, '_');
    expect(parseKeyMaterial(urlSafe)).toEqual(parseKeyMaterial(B64));
  });

  it('accepts exactly 32 characters typed by hand', () => {
    expect(parseKeyMaterial(PLAIN)).toHaveLength(32);
  });

  it('trims, because a copied variable brings whitespace with it', () => {
    expect(parseKeyMaterial(`  ${HEX}\n`)).toEqual(parseKeyMaterial(HEX));
  });

  it('refuses a short key rather than stretching it', () => {
    // A key silently derived from a weak string is a key of unknown strength, and
    // nobody would ever find out. Refusing is the only honest answer.
    expect(() => parseKeyMaterial('hunter2')).toThrow(EncryptionKeyError);
    expect(() => parseKeyMaterial('')).toThrow(EncryptionKeyError);
    expect(() => parseKeyMaterial('a'.repeat(31))).toThrow(EncryptionKeyError);
  });

  it('says how to make one', () => {
    expect(() => parseKeyMaterial('short')).toThrow(/openssl rand -base64 32/);
  });
});

describe('seal and open', () => {
  it('round-trips a cookie header', async () => {
    const key = await importKey(HEX);
    const header = 'FTSession=abc; FTUser=def; consent=1';
    expect(await open(await seal(header, key), key)).toBe(header);
  });

  it('round-trips non-ASCII and a very long value', async () => {
    const key = await importKey(HEX);
    // The chunked base64 path: a header long enough to blow a spread argument list.
    const long = `sess=${'ü'.repeat(50_000)}`;
    expect(await open(await seal(long, key), key)).toBe(long);
  });

  it('never produces the same blob twice', async () => {
    // GCM's one absolute rule is that an IV is never reused under a key. Equal
    // ciphertexts for equal plaintexts would mean the IV is fixed.
    const key = await importKey(HEX);
    const a = await seal('same', key);
    const b = await seal('same', key);
    expect(a).not.toBe(b);
  });

  it('refuses a blob sealed under a different key', async () => {
    const blob = await seal('secret', await importKey(HEX));
    await expect(open(blob, await importKey(PLAIN))).rejects.toThrow(CorruptBlobError);
  });

  it('refuses a tampered blob', async () => {
    const key = await importKey(HEX);
    const blob = await seal('secret', key);
    // Flip a character in the ciphertext. GCM authenticates, so this must not decrypt
    // to anything at all — least of all to a partially correct cookie header.
    const flipped = `${blob.slice(0, -4)}${blob.at(-4) === 'A' ? 'B' : 'A'}${blob.slice(-3)}`;
    await expect(open(flipped, key)).rejects.toThrow(CorruptBlobError);
  });

  it('refuses a blob with an unknown version byte', async () => {
    const key = await importKey(HEX);
    const bytes = Uint8Array.from(atob(await seal('secret', key)), (c) => c.charCodeAt(0));
    bytes[0] = 9;
    const relabelled = btoa(String.fromCharCode(...bytes));
    await expect(open(relabelled, key)).rejects.toThrow(/unknown blob version 9/);
  });

  it('refuses rubbish rather than crashing', async () => {
    const key = await importKey(HEX);
    for (const junk of ['', 'not base64!!', 'AAAA', btoa('short')]) {
      await expect(open(junk, key)).rejects.toThrow(CorruptBlobError);
    }
  });
});
