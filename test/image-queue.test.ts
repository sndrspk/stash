import { describe, expect, it } from 'vitest';

import { hostOf, runBounded } from '../src/lib/image-queue';

/**
 * A clock the test owns.
 *
 * `sleep` advances it rather than waiting, so a one-second per-host delay is
 * asserted in microseconds. The alternative — real timers — would make this file
 * take minutes and be flaky about it.
 */
function fakeClock() {
  let at = 0;
  return {
    now: () => at,
    sleep: (ms: number) => {
      at += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      at += ms;
    },
  };
}

const yieldOnce = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('hostOf', () => {
  it('is the hostname, case-folded, ignoring scheme and port', () => {
    expect(hostOf('https://WWW.Example.com:8443/a')).toBe('www.example.com');
    expect(hostOf('http://www.example.com/b')).toBe('www.example.com');
  });

  it('gives an unparseable URL a bucket of its own', () => {
    // Otherwise every malformed entry would share one bucket and throttle each other.
    expect(hostOf('nonsense')).not.toBe(hostOf('other nonsense'));
  });
});

describe('runBounded', () => {
  it('visits every item exactly once', async () => {
    const clock = fakeClock();
    const items = Array.from({ length: 25 }, (_, i) => `https://host${i % 5}.example/${i}`);
    const seen: string[] = [];

    await runBounded(
      items,
      async (url) => {
        seen.push(url);
        await yieldOnce();
      },
      { ...clock, perHostDelayMs: 0 },
    );

    expect(seen).toHaveLength(items.length);
    expect(new Set(seen)).toEqual(new Set(items));
  });

  it('never runs more than the concurrency limit at once', async () => {
    const clock = fakeClock();
    const items = Array.from({ length: 12 }, (_, i) => `https://host${i}.example/x`);

    let inFlight = 0;
    let peak = 0;

    await runBounded(
      items,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await yieldOnce();
        inFlight -= 1;
      },
      { ...clock, concurrency: 3, perHostDelayMs: 0 },
    );

    expect(peak).toBe(3);
  });

  it('leaves at least the per-host delay between requests to one host', async () => {
    const clock = fakeClock();
    const items = Array.from({ length: 4 }, (_, i) => `https://one.example/${i}`);
    const starts: number[] = [];

    await runBounded(
      items,
      async () => {
        starts.push(clock.now());
        await yieldOnce();
      },
      { ...clock, concurrency: 3, perHostDelayMs: 1000 },
    );

    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
  });

  it('does not let one busy host stall the others behind it', async () => {
    // The reason the scheduler looks past a cooling-down item instead of holding a
    // slot: twenty articles from one newspaper must not delay every other publisher.
    const clock = fakeClock();
    const items = [
      'https://one.example/a',
      'https://one.example/b',
      'https://one.example/c',
      'https://two.example/a',
      'https://three.example/a',
    ];
    const startedAt = new Map<string, number>();

    await runBounded(
      items,
      async (url) => {
        startedAt.set(url, clock.now());
        await yieldOnce();
      },
      { ...clock, concurrency: 2, perHostDelayMs: 1000 },
    );

    expect(startedAt.get('https://two.example/a')).toBe(0);
    expect(startedAt.get('https://three.example/a')).toBe(0);
  });

  it('does not delay hosts that merely share a suffix', async () => {
    const clock = fakeClock();
    const starts: number[] = [];

    await runBounded(
      ['https://a.example.com/x', 'https://b.example.com/x'],
      async () => {
        starts.push(clock.now());
        await yieldOnce();
      },
      { ...clock, concurrency: 2, perHostDelayMs: 1000 },
    );

    expect(starts).toEqual([0, 0]);
  });

  it('carries on past a worker that throws', async () => {
    const clock = fakeClock();
    const items = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'];
    const seen: string[] = [];

    await runBounded(
      items,
      async (url) => {
        seen.push(url);
        await yieldOnce();
        if (url.endsWith('1')) throw new Error('one bad URL out of two hundred');
      },
      { ...clock, concurrency: 1, perHostDelayMs: 0 },
    );

    expect(seen).toEqual(items);
  });

  it('stops taking new items once aborted', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const items = Array.from({ length: 10 }, (_, i) => `https://host${i}.example/x`);
    const seen: string[] = [];

    await runBounded(
      items,
      async (url) => {
        seen.push(url);
        await yieldOnce();
        if (seen.length === 2) controller.abort();
      },
      { ...clock, concurrency: 1, perHostDelayMs: 0, signal: controller.signal },
    );

    expect(seen).toHaveLength(2);
  });

  it('does nothing at all for an empty list', async () => {
    const clock = fakeClock();
    let calls = 0;
    await runBounded(
      [],
      async () => {
        calls += 1;
      },
      clock,
    );
    expect(calls).toBe(0);
  });
});
