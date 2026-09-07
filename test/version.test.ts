import { describe, expect, it } from 'vitest';

import { APP_VERSION, versionLabel } from '../src/lib/version';

/*
 * The version is bumped by hand, in the PR that ships the change, using that PR's own
 * number. Nothing here can check it against reality — a build has no idea which pull
 * request it came from — so these check the shape and nothing more, and say so rather
 * than implying a guarantee they do not give.
 *
 * A stale number is worse than no number: it would say a fix is live when it is not.
 * That risk is carried by the habit recorded in CLAUDE.md, not by this file.
 */
describe('the version badge', () => {
  it('is a positive whole number', () => {
    // Guards the typo that would otherwise render as `vNaN` or `v31.0`.
    expect(Number.isInteger(APP_VERSION)).toBe(true);
    expect(APP_VERSION).toBeGreaterThan(0);
  });

  it('renders as v followed by the number', () => {
    expect(versionLabel(31)).toBe('v31');
    expect(versionLabel(7)).toBe('v7');
  });

  it('only ever moves forward', () => {
    // A floor rather than an assertion about the current value: it stops a merge or a
    // revert from quietly taking the number backwards, without needing an update on
    // every bump. Raise it occasionally; never lower it.
    expect(APP_VERSION).toBeGreaterThanOrEqual(31);
  });
});
