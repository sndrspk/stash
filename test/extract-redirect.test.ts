import { describe, expect, it } from 'vitest';

import { reachedSameSite } from '../src/lib/extract';

/*
 * A redirect out of the publisher's own domain is not the article.
 *
 * Found on a real page: knack.be sends an unauthenticated request through four
 * redirects to sso.roularta.be, which answers 200 with a sign-in form. That extracts
 * perfectly — into a paragraph reading "Inloggen. Vul hier je e-mailadres…" — and
 * would be stored as the article. A visible failure is better than a cached article
 * that is quietly wrong and looks like the publisher's own text.
 */
describe('reachedSameSite', () => {
  it('allows the redirects a publisher makes for its own reasons', () => {
    expect(reachedSameSite('https://knack.be/a', 'https://www.knack.be/a')).toBe(true);
    expect(reachedSameSite('https://www.knack.be/a', 'https://knack.be/a')).toBe(true);
    expect(reachedSameSite('https://www.nrc.nl/a', 'https://www.nrc.nl/b?utm=1')).toBe(true);
    expect(reachedSameSite('https://nrc.nl/a', 'https://podcast.nrc.nl/a')).toBe(true);
  });

  it('refuses a redirect to somewhere else entirely', () => {
    expect(reachedSameSite('https://www.knack.be/nieuws/x', 'https://sso.roularta.be/login')).toBe(
      false,
    );
    expect(reachedSameSite('https://www.ft.com/a', 'https://accounts.google.com/signin')).toBe(
      false,
    );
  });

  it('is not fooled by a suffix that merely looks related', () => {
    // The same trap RFC 6265 matching exists to avoid: fakeknack.be is not knack.be.
    expect(reachedSameSite('https://knack.be/a', 'https://fakeknack.be/a')).toBe(false);
  });

  it('declines to judge what it cannot parse', () => {
    // Inventing a failure from an unparseable URL would turn a working fetch into a
    // reported error, which is the more expensive mistake of the two.
    expect(reachedSameSite('not a url', 'https://www.knack.be/a')).toBe(true);
  });
});
