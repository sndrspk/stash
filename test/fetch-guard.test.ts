import { afterEach, describe, expect, it } from 'vitest';
import {
  BlockedUrlError,
  USER_AGENT,
  addressBlocked,
  assertFetchable,
  guardedFetch,
  isInstapaperHost,
  setDnsResolverForTests,
  validatingLookup,
} from '../src/lib/fetch-guard.js';

describe('addressBlocked', () => {
  it('blocks loopback, private and link-local IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '0.0.0.0',
    ]) {
      expect(addressBlocked(ip, 4), ip).toBe(true);
    }
  });

  // The one that matters most: the cloud metadata endpoint.
  it('blocks the link-local metadata address', () => {
    expect(addressBlocked('169.254.169.254', 4)).toBe(true);
  });

  it('blocks CGNAT, benchmarking, documentation and multicast ranges', () => {
    for (const ip of [
      '100.64.0.1',
      '198.18.0.1',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(addressBlocked(ip, 4), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.167.1.1', '100.63.255.255']) {
      expect(addressBlocked(ip, 4), ip).toBe(false);
    }
  });

  it('blocks loopback, unique-local and link-local IPv6', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
    ]) {
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
    await expect(assertFetchable(new URL('file:///etc/passwd'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertFetchable(new URL('ftp://example.com/x'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('refuses to fetch instapaper.com, whose terms forbid it', async () => {
    await expect(assertFetchable(new URL('https://www.instapaper.com/u'))).rejects.toThrow(
      /instapaper/i,
    );
  });

  it('rejects a host that resolves to a blocked address', async () => {
    await expect(assertFetchable(new URL('http://localhost:8080/'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertFetchable(new URL('http://127.0.0.1/'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(
      assertFetchable(new URL('http://169.254.169.254/latest/meta-data/')),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects a host that does not resolve', async () => {
    await expect(assertFetchable(new URL('http://no-such-host.invalid/'))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });
});

/*
 * The honest User-Agent, and there is no longer a way to send anything else.
 *
 * `STASH_USER_AGENT` existed because most paywalled publishers refuse a non-browser
 * User-Agent with a 403, which mattered when Stash fetched their articles. It does not
 * fetch articles any more — only `og:image` for a page the reader already saved — so the
 * override went with the lane it served, and this asserts the constant it left behind.
 */
describe('USER_AGENT', () => {
  it('says what the app is, and links to it', () => {
    expect(USER_AGENT).toContain('Stash/');
    expect(USER_AGENT).toContain('github.com');
  });
});

/*
 * DNS rebinding: the nameserver answers the pre-check with a public address and the
 * connection with a blocked one. This is the scenario `validatingLookup` exists for —
 * the pre-check alone waves it through, because each lookup it made was individually
 * clean at the moment it was made.
 *
 * The stateful resolver below makes the scenario deterministic: the first call is the
 * pre-check's, the second is the connection's. And the refusal is asserted never to
 * have opened a socket — it happens inside the connection's `lookup` hook, which
 * Node calls before connecting, so a refusal that happened after would be too late
 * to be worth anything.
 */
describe('DNS rebinding', () => {
  afterEach(() => {
    setDnsResolverForTests(null);
  });

  it('refuses at connect time when the resolver rebinds to a blocked address', async () => {
    const answers = [
      { address: '93.184.216.34', family: 4 }, // public: passes the pre-check
      { address: '169.254.169.254', family: 4 }, // metadata: refused at the socket
    ];
    let calls = 0;
    setDnsResolverForTests(async () => [answers[calls++ % answers.length]!]);
    await expect(guardedFetch('http://rebinding.attacker.test/latest/meta-data/')).rejects.toThrow(
      /rebound to blocked address/,
    );
  });

  it('keeps the rebinding refusal permanent, so a client caches it rather than retrying', async () => {
    // The same scenario, asserted on the type rather than the message: the hook must
    // refuse with a BlockedUrlError (permanent by default), because `resolve-image`
    // caches a permanent refusal as "never ask again" — and a rebinding host is
    // exactly the host never worth asking twice.
    const answers = [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    let calls = 0;
    setDnsResolverForTests(async () => [answers[calls++ % answers.length]!]);
    await expect(guardedFetch('http://rebinding.attacker.test/')).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('refuses, before any socket exists, when only some answers are clean', async () => {
    // The all-answers veto at connect time: one clean answer and one hostile one is
    // still a hostile host, whichever address the connect loop would have reached.
    setDnsResolverForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(guardedFetch('http://mixed.attacker.test/latest/meta-data/')).rejects.toThrow(
      BlockedUrlError,
    );
  });
});

describe('validatingLookup', () => {
  afterEach(() => {
    setDnsResolverForTests(null);
  });

  it('hands clean answers to Node unchanged, one call for the whole set', async () => {
    const answers = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:10::6814:179a', family: 6 },
    ];
    setDnsResolverForTests(async () => answers);
    await new Promise<void>((resolve, reject) => {
      validatingLookup('clean.example.test', { all: true }, (err, address) => {
        if (err !== null) {
          reject(err);
          return;
        }
        expect(address).toEqual(answers);
        resolve();
      });
    });
  });

  it('refuses a blocked answer as a permanent error, before the socket exists', async () => {
    setDnsResolverForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    await new Promise<void>((resolve, reject) => {
      validatingLookup('metadata.attacker.test', { all: true }, (err) => {
        expect(err).toBeInstanceOf(BlockedUrlError);
        if (!(err instanceof BlockedUrlError)) {
          reject(err);
          return;
        }
        expect(err.permanent).toBe(true);
        resolve();
      });
    });
  });

  it('refuses an empty answer set rather than letting Node connect nowhere', async () => {
    setDnsResolverForTests(async () => []);
    await new Promise<void>((resolve, reject) => {
      validatingLookup('empty.attacker.test', { all: true }, (err) => {
        expect(err).toBeInstanceOf(BlockedUrlError);
        if (!(err instanceof BlockedUrlError)) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });
});
