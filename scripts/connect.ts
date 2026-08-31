/**
 * `npm run connect` — the one-time xAuth exchange.
 *
 * Prompts for an Instapaper email and password, trades them once for an OAuth
 * token, prints it as ready-to-paste env lines, and exits. Nothing is written to
 * disk, nothing is logged, and the password is never sent anywhere but Instapaper.
 *
 * This is the whole reason the deployed app has no login screen. The password
 * exists only inside this process, on the operator's own machine, for the length
 * of one request — which honours Instapaper's terms more strictly than storing
 * credentials server-side ever could, because there is no store to leak.
 *
 * Run it again whenever the token needs replacing; it has no state to corrupt.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';

import { signRequest } from '../src/lib/oauth';

/** Control bytes we must handle ourselves once the terminal is in raw mode. */
const ETX = '\u0003'; // Ctrl-C
const DEL = '\u007f'; // Backspace on most terminals

const ACCESS_TOKEN_URL = 'https://www.instapaper.com/api/1/oauth/access_token';

/**
 * Reads a line without echoing it.
 *
 * `readline` has no hidden-input mode, so the terminal is put in raw mode and the
 * keystrokes are collected directly. The `finally` is load-bearing: leaving a
 * shell in raw mode on an error would render it unusable.
 */
async function readPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    // Piped input would otherwise echo the password into the terminal, into
    // scrollback, and possibly into a CI log.
    throw new Error('connect must be run interactively — it will not read a password from a pipe');
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  try {
    let value = '';
    for await (const chunk of stdin) {
      const text = chunk as string;
      for (const char of text) {
        switch (char) {
          case '\r':
          case '\n':
            stdout.write('\n');
            return value;
          case ETX: // Ctrl-C — raw mode means we handle this ourselves.
            stdout.write('\n');
            exit(130);
            break;
          case DEL:
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            // Drop other control characters rather than embedding them in the
            // password, where they would silently corrupt the exchange.
            if (char >= ' ' && char !== DEL) value += char;
        }
      }
    }
    return value;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  exit(1);
}

async function main(): Promise<void> {
  const consumerKey = env.INSTAPAPER_CONSUMER_KEY;
  const consumerSecret = env.INSTAPAPER_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    fail(
      'INSTAPAPER_CONSUMER_KEY and INSTAPAPER_CONSUMER_SECRET must be set.\n\n' +
        'Copy .env.example to .env, fill in the two values Instapaper issued you,\n' +
        'and run `npm run connect` again — it reads .env automatically.',
    );
  }

  console.log('\nStash — one-time Instapaper connection\n');
  console.log('Your password is used for a single request and then discarded.');
  console.log('It is never written to disk and never reaches the deployed app.\n');

  const rl = createInterface({ input: stdin, output: stdout });
  const email = (await rl.question('Instapaper email: ')).trim();
  rl.close();

  if (!email) fail('No email given.');

  const password = await readPassword('Instapaper password (not shown): ');
  if (!password) fail('No password given.');

  // xAuth sends the credentials as signed protocol parameters, not as a body.
  const { header } = signRequest({
    method: 'POST',
    url: ACCESS_TOKEN_URL,
    consumerKey,
    consumerSecret,
    extra: [
      ['x_auth_username', email],
      ['x_auth_password', password],
      ['x_auth_mode', 'client_auth'],
    ],
  });

  process.stdout.write('\nExchanging… ');

  let response: Response;
  try {
    response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: header,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '0',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`could not reach Instapaper: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await response.text();

  if (!response.ok) {
    console.log('failed.\n');
    if (response.status === 401) {
      // The single most likely cause, and the one that looks like a code bug but
      // is not. The RFC 5849 tests in test/oauth.test.ts are what license this
      // claim: if they pass, the signature is well-formed and the problem is
      // permissions or credentials.
      fail(
        'Instapaper returned 401.\n\n' +
          'Three possibilities, in order of likelihood:\n' +
          '  1. xAuth is not enabled on your consumer key. It is granted per\n' +
          '     application, separately from Full API access, and it fails only\n' +
          '     here. Ask Instapaper to enable it.\n' +
          '  2. The email or password is wrong.\n' +
          '  3. The consumer key/secret is wrong.\n\n' +
          'It is almost certainly not the request signing: that is verified against\n' +
          "RFC 5849's own worked example by `npm test`.",
      );
    }
    fail(`Instapaper returned HTTP ${response.status}.\n${body.slice(0, 400)}`);
  }

  // The response is form-encoded, not JSON.
  const parsed = new URLSearchParams(body);
  const token = parsed.get('oauth_token');
  const tokenSecret = parsed.get('oauth_token_secret');

  if (!token || !tokenSecret) {
    console.log('failed.\n');
    fail(`Instapaper returned 200 without a token.\nBody: ${body.slice(0, 400)}`);
  }

  console.log('done.\n');
  console.log("Add these to your .env locally, and to your host's environment variables");
  console.log('in production. Treat them like a password — they grant full access to');
  console.log('your Instapaper account.\n');
  console.log(`INSTAPAPER_OAUTH_TOKEN=${token}`);
  console.log(`INSTAPAPER_OAUTH_TOKEN_SECRET=${tokenSecret}\n`);
  console.log('Nothing was saved. Re-run this any time to get a fresh token.\n');
}

// `--help` before anything else, so the script can be inspected without a prompt.
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    '\nnpm run connect — exchange an Instapaper email and password for an OAuth token.\n\n' +
      'Requires INSTAPAPER_CONSUMER_KEY and INSTAPAPER_CONSUMER_SECRET in the\n' +
      'environment. Prints the resulting token; stores nothing.\n',
  );
  exit(0);
}

await main();
