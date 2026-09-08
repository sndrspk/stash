/**
 * The probe's closing verdict, which is the only part of it anyone reads carefully.
 *
 * Both cases here were live bugs, and both were wrong in the same direction: the sentence
 * claimed more than the numbers under it supported. One announced a subscription pitch as
 * a success in green; the other offered two explanations for a short result when the
 * results themselves distinguished them. That is the failure mode `CLAUDE.md` calls out —
 * saying what something probably means instead of what happened — so it gets a test rather
 * than a comment.
 */

import { describe, expect, it, vi } from 'vitest';
import { sessionRecognised, summarize } from '../scripts/probe.js';
import type { ExtractResult } from '../src/lib/extract.js';
import { USER_AGENT } from '../src/lib/fetch-guard.js';

function success(overrides: Partial<Extract<ExtractResult, { ok: true }>> = {}) {
  const text = overrides.text ?? 'a'.repeat(4000);
  return {
    ok: true as const,
    url: 'https://example.com/a',
    status: 200,
    rawBytes: 50_000,
    redirects: 0,
    authenticated: false,
    title: 'A headline',
    byline: null,
    html: `<p>${text}</p>`,
    text,
    truncation: { truncated: text.length < 1500, reasons: [], chars: text.length },
    ...overrides,
  };
}

const failure = (tag: string): ExtractResult => ({
  ok: false,
  url: 'https://example.com/a',
  tag,
  authenticated: false,
});

/** Run `summarize` and return everything it printed, ANSI codes and all. */
function verdictFor(
  anon: ExtractResult | null,
  auth: ExtractResult | null,
  userAgent?: string,
): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    summarize('example.com', anon, auth, userAgent);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('sessionRecognised', () => {
  it('reads a redirect the anonymous fetch took and the authenticated one did not', () => {
    const evidence = sessionRecognised(failure('Redirected to sso.example.org'), success());
    expect(evidence).toContain('sso.example.org');
  });

  it('reads a substantially larger authenticated response', () => {
    const evidence = sessionRecognised(
      success({ rawBytes: 13 * 1024 }),
      success({ rawBytes: 183 * 1024 }),
    );
    expect(evidence).toContain('183 KB');
    expect(evidence).toContain('13 KB');
  });

  it('finds no evidence when both responses are the same size', () => {
    expect(sessionRecognised(success({ rawBytes: 50_000 }), success({ rawBytes: 52_000 }))).toBe(
      null,
    );
  });

  it('finds no evidence when the authenticated fetch failed outright', () => {
    expect(sessionRecognised(success(), failure('HTTP 403'))).toBe(null);
  });
});

describe('summarize', () => {
  /*
   * The regression, exactly as it reached a user. `reachedSameSite` began failing the
   * anonymous fetch on a publisher that redirects to SSO, which took `anonChars` to zero —
   * and the test was `authChars > anonChars * 1.5`, so 332 characters of subscription
   * pitch beat it and were reported in green as the session doing the work.
   */
  it('does not call a truncated authenticated result a success', () => {
    const pitch = 'Word abonnee. Abonneer nu.';
    const verdict = verdictFor(
      failure('Redirected to sso.example.org'),
      success({ text: pitch, rawBytes: 183 * 1024 }),
    );
    expect(verdict).not.toContain('doing the work');
    expect(verdict).not.toContain('not optional here');
    expect(verdict).toContain("article still isn't here");
  });

  it('says the session is honoured, with the number behind it, when the body is absent', () => {
    const verdict = verdictFor(
      success({ text: 'short', rawBytes: 13 * 1024 }),
      success({ text: 'also short', rawBytes: 183 * 1024 }),
    );
    expect(verdict).toContain('being honoured');
    expect(verdict).toContain('183 KB');
    expect(verdict).toContain('not an expired session');
    expect(verdict).toContain('--raw');
  });

  it('guesses expiry first when nothing says the session was recognised', () => {
    const verdict = verdictFor(
      success({ text: 'short', rawBytes: 50_000 }),
      success({ text: 'short', rawBytes: 50_000 }),
    );
    expect(verdict).toContain('changed nothing');
    expect(verdict).toContain('expired');
  });

  it('still credits a session that produces a complete article', () => {
    const verdict = verdictFor(
      success({ text: 'short', rawBytes: 13 * 1024 }),
      success({ rawBytes: 183 * 1024 }),
    );
    expect(verdict).toContain('doing the work');
  });

  it('still reports a publisher that refuses anonymous fetches outright', () => {
    const verdict = verdictFor(failure('HTTP 403'), success());
    expect(verdict).toContain('not optional here');
  });

  it('still reports a refusal both ways', () => {
    const verdict = verdictFor(failure('HTTP 403'), failure('HTTP 403'));
    expect(verdict).toContain('Refused both ways');
  });

  /*
   * The refusal hint printed one fixed paragraph advising a browser User-Agent, and
   * printed it verbatim to a run that had just been given one with `--ua`. Advice to try
   * what you have already tried reads as though the tool looked and found nothing
   * changed, when it never looked at all.
   */
  it('suggests a browser User-Agent only when the honest default went out', () => {
    const verdict = verdictFor(failure('HTTP 403'), failure('HTTP 403'), USER_AGENT);
    expect(verdict).toContain('Stash/0.1');
    expect(verdict).toContain('--ua');
  });

  it('does not suggest a browser User-Agent when one was already sent', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
    const verdict = verdictFor(failure('HTTP 403'), failure('HTTP 403'), chrome);
    expect(verdict).not.toContain('Stash/0.1');
    expect(verdict).toContain('already sent');
    expect(verdict).toContain('not about how the');
  });
});
