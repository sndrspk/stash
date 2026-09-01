import { describe, expect, it } from 'vitest';

import { ConfigError, requireEnv } from '../src/lib/guard';
import { credentialsFromEnv } from '../src/lib/instapaper';

/*
 * A deployment with the token pair set but the consumer pair missing produced two
 * screens that disagreed about it. `/settings` reported "could not reach Instapaper"
 * and Sync reported `not_configured`, so the same deployment looked misconfigured on
 * one screen and unreachable on the other, and neither said which variable was
 * missing — though both had been handed a message that named it.
 *
 * Two separate faults, and the second is the one that costs time:
 *
 *  - `api/bookmarks` discarded `error.message` and returned the bare code, while
 *    `api/status` kept it. One screen could answer the question and the other could
 *    not, for no reason other than which handler you happened to hit.
 *  - `/settings`'s generic branch substituted "Could not reach Instapaper" for
 *    whatever actually threw — the same failure as announcing an empty folder when
 *    the response merely failed to parse.
 *
 * These pin what the config error carries. They are cheap, and the alternative is
 * another round trip to learn something the process already knew.
 */
describe('the missing-variable message', () => {
  const read = (present: Record<string, string>) => (name: string) => {
    const value = present[name];
    if (!value) throw new ConfigError(`${name} is not set`);
    return value;
  };

  it('names the first variable that is missing', () => {
    try {
      credentialsFromEnv(
        read({
          INSTAPAPER_OAUTH_TOKEN: 'token',
          INSTAPAPER_OAUTH_TOKEN_SECRET: 'secret',
        }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      // The exact case that happened: token pair set, consumer pair not.
      expect((error as Error).message).toBe('INSTAPAPER_CONSUMER_KEY is not set');
    }
  });

  it('names each of the four, so no missing variable is anonymous', () => {
    const all = {
      INSTAPAPER_CONSUMER_KEY: 'k',
      INSTAPAPER_CONSUMER_SECRET: 's',
      INSTAPAPER_OAUTH_TOKEN: 't',
      INSTAPAPER_OAUTH_TOKEN_SECRET: 'ts',
    };

    for (const missing of Object.keys(all)) {
      const rest = { ...all };
      delete rest[missing as keyof typeof all];
      expect(() => credentialsFromEnv(read(rest))).toThrowError(`${missing} is not set`);
    }
  });

  it('carries no value, only the name', () => {
    // This message reaches a browser. It must say which variable is unset and
    // nothing about what any variable contains.
    try {
      requireEnv('DEFINITELY_UNSET_VARIABLE_FOR_TEST');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('DEFINITELY_UNSET_VARIABLE_FOR_TEST is not set');
    }

    process.env.STASH_TEST_SECRET = 'super-secret-value';
    try {
      expect(requireEnv('STASH_TEST_SECRET')).toBe('super-secret-value');
      // A set variable returns its value and reports nothing, which is the point:
      // only the absent ones are ever named aloud.
    } finally {
      delete process.env.STASH_TEST_SECRET;
    }
  });
});
