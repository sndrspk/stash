import { describe, expect, it } from 'vitest';

import { TO_UNLOCK, classifyStatusResponse as classify, type Status } from '../src/lib/status-view';

/*
 * `/settings` fetched `/api/status` and cast whatever came back to a status object,
 * checking only for 401. A refusal from the guard is not a status object: it is
 * `{ error: 'not_configured' }` with a 503, and casting it yields `connected`,
 * `reason` and `detail` all undefined — which the screen renders as
 *
 *   Not connected.
 *   Could not reach Instapaper.
 *
 * with no detail box. So a deployment with no `STASH_PASSPHRASE`, refusing every
 * call before a line of Instapaper code runs, reported itself as an Instapaper
 * connectivity problem. Sync read the same body's `error` field and said
 * `not_configured`. One cause, two unrelated-sounding messages, and neither named it.
 *
 * This is the third time in this project that a misconfiguration has been reported
 * as a different kind of failure — after "the unread folder is empty" and
 * "could not reach Instapaper". The shape is always the same: a value is coerced
 * into a type it does not belong to, and the mismatch renders as plausible.
 *
 * These assert the classification the screen actually uses — the function is
 * imported, not restated here, because a copy would only test my belief about it.
 */

describe('what /settings makes of a response', () => {
  it('reports a guard refusal as a refusal, naming the status and the code', () => {
    const result = classify(503, { error: 'not_configured' });
    expect(result).toEqual({
      connected: false,
      reason: 'refused',
      detail: '/api/status answered 503 — not_configured',
    });
  });

  it('does not let a refusal masquerade as an Instapaper failure', () => {
    // The exact bug: `reason` undefined fell through to the generic explanation,
    // which blamed the network path to Instapaper.
    const result = classify(503, { error: 'not_configured' });
    expect(result).not.toBe(TO_UNLOCK);
    expect((result as Status).reason).toBe('refused');
    expect((result as Status).reason).not.toBeUndefined();
  });

  it('still sends an expired session to the gate', () => {
    expect(classify(401, { error: 'unauthorized' })).toBe(TO_UNLOCK);
  });

  it('survives a refusal whose body is not JSON', () => {
    const result = classify(502, null);
    expect((result as Status).detail).toBe('/api/status answered 502');
    expect((result as Status).connected).toBe(false);
  });

  it('passes a real status through untouched', () => {
    const ok = { connected: true, username: 'reader' };
    expect(classify(200, ok)).toEqual(ok);

    const configured = { connected: false, reason: 'not_configured', detail: 'X is not set' };
    expect(classify(200, configured)).toEqual(configured);
  });

  it('distinguishes the two not_configured answers, which mean different things', () => {
    /*
     * They share a code and have nothing else in common:
     *
     *  - 503 from the guard — STASH_PASSPHRASE is unset; nothing reached Instapaper.
     *  - 200 from the handler — the gate passed, and an INSTAPAPER_* variable is
     *    unset.
     *
     * Reading the first as the second sends the operator to check Instapaper
     * credentials that were never consulted.
     */
    const fromGuard = classify(503, { error: 'not_configured' }) as Status;
    const fromHandler = classify(200, {
      connected: false,
      reason: 'not_configured',
      detail: 'INSTAPAPER_CONSUMER_KEY is not set',
    }) as Status;

    expect(fromGuard.reason).toBe('refused');
    expect(fromHandler.reason).toBe('not_configured');
    expect(fromGuard.reason).not.toBe(fromHandler.reason);
  });
});
