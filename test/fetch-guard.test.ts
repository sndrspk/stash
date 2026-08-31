import { describe, expect, it } from 'vitest';
import { BlockedUrlError, addressBlocked, assertFetchable, isInstapaperHost } from '../src/lib/fetch-guard.js';

describe('addressBlocked', () => {
  it('blocks loopback, private and link-local IPv4', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0']) {
      expect(addressBlocked(ip, 4), ip).toBe(true);
    }
  });

  // The one that matters most: the cloud metadata endpoint.
  it('blocks the link-local metadata address', () => {
    expect(addressBlocked('169.254.169.254', 4)).toBe(true);
  });

  it('blocks CGNAT, benchmarking, documentation and multicast ranges', () => {
    for (const ip of ['100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) {
      expect(addressBlocked(ip, 4), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.167.1.1', '100.63.255.255']) {
      expect(addressBlocked(ip, 4), ip).toBe(false);
    }
  });

  it('blocks loopback, unique-local and link-local IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
      expect(addressBlocked(ip, 6), ip).toBe(true);
    }
  });

  // An IPv4-mapped address must be judged on the address it embeds.
  it('unwraps IPv4-mapped IPv6 rather than waving it through', () => {
    expect(addressBlocked('::ffff:127.0.0.1', 6)).toBe(true);
    expect(addressBlocked('::ffff:169.254.169.254', 6)).toBe(true);
    expect(addressBlocked('::ffff:8.8.8.8', 6)).toBe(false);
  });

  it('allows ordinary public IPv6', () => {
    expect(addressBlocked('2606:4700:4700::1111', 6)).toBe(false);
  });

  it('refuses an unparseable address rather than guessing', () => {
    expect(addressBlocked('999.1.1.1', 4)).toBe(true);
    expect(addressBlocked('nonsense', 4)).toBe(true);
  });
});

describe('isInstapaperHost', () => {
  it('recognises instapaper and its subdomains', () => {
    expect(isInstapaperHost('instapaper.com')).toBe(true);
    expect(isInstapaperHost('www.Instapaper.com')).toBe(true);
    expect(isInstapaperHost('instapaper.com.')).toBe(true);
  });

  it('is not fooled by a lookalike host', () => {
    expect(isInstapaperHost('notinstapaper.com')).toBe(false);
    expect(isInstapaperHost('instapaper.com.evil.test')).toBe(false);
  });
});

describe('assertFetchable', () => {
  it('rejects non-HTTP schemes', async () => {
    await expect(assertFetchable(new URL('file:///etc/passwd'))).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertFetchable(new URL('ftp://example.com/x'))).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('refuses to fetch instapaper.com, whose terms forbid it', async () => {
    await expect(assertFetchable(new URL('https://www.instapaper.com/u'))).rejects.toThrow(/instapaper/i);
  });

  it('rejects a host that resolves to a blocked address', async () => {
    await expect(assertFetchable(new URL('http://localhost:8080/'))).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertFetchable(new URL('http://127.0.0.1/'))).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertFetchable(new URL('http://169.254.169.254/latest/meta-data/'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('rejects a host that does not resolve', async () => {
    await expect(assertFetchable(new URL('http://no-such-host.invalid/'))).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
