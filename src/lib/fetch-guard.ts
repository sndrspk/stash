/**
 * Guarded outbound fetch.
 *
 * The image resolver fetches a URL that ultimately came from a third party, from
 * inside our own infrastructure. That is textbook SSRF exposure, so every hop is
 * validated: scheme, resolved address, redirect target, response size and a
 * wall-clock deadline.
 *
 * **The address vetted is the address connected to.** `assertFetchable` resolves the
 * host and refuses the fetch if any answer is blocked, but a second resolution
 * happens when the socket connects — and DNS rebinding is exactly the trick of
 * answering the two lookups differently: a public address for the check, the cloud
 * metadata endpoint for the connection. So the connection itself resolves through
 * `validatingLookup`, the `lookup` hook of `node:http(s).request`, which vets every
 * address at the moment it is handed to the socket. A rebound answer is refused
 * there, whatever the pre-check saw.
 */

import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * What this app says it is: an app, saying so, with a link.
 *
 * The only thing that fetches a publisher's page now is `og:image` resolution, for one
 * article the reader already saved — so the honest introduction costs nothing and is
 * simply correct. It is not overridable any more: the override existed because most
 * paywalled publishers refuse a non-browser User-Agent, which mattered when Stash was
 * trying to read their articles and does not now.
 */
export const USER_AGENT = 'Stash/0.1 (+https://github.com/sndrspk/stash)';

/** SanFeedBin's numbers: short, because this runs unattended during a sync. */
export const CONNECT_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 15_000;
/** Node's fetch does not split connect from read, so the deadline is the sum. */
export const TOTAL_TIMEOUT_MS = CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS;

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * A request that was refused rather than attempted, or abandoned part-way.
 *
 * `permanent` separates "this URL can never work" — a blocked address, a scheme we
 * do not speak, a redirect loop — from "this attempt did not work", which is only
 * the timeout. Callers that cache a result need the distinction: a permanent
 * refusal must be remembered so it is never retried, and a timeout must not be.
 */
export class BlockedUrlError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent = true) {
    super(message);
    this.permanent = permanent;
  }
}

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: refuse rather than guess
  }
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  void d;
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? '';
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible: judge the embedded v4 address.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1] !== undefined) return ipv4Blocked(mapped[1]);
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (addr.startsWith('2001:db8')) return true; // documentation
  if (addr.startsWith('ff')) return true; // multicast
  return false;
}

export function addressBlocked(ip: string, family: number): boolean {
  return family === 6 ? ipv6Blocked(ip) : ipv4Blocked(ip);
}

/**
 * Instapaper's own terms forbid scraping their pages. A bookmark's `url` field is the
 * original third-party source and should never point at them — if it does, something is
 * wrong and we stop rather than fetch.
 */
export function isInstapaperHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return h === 'instapaper.com' || h.endsWith('.instapaper.com');
}

/** One answer from the resolver, at the moment it was given. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** A resolver, injectable so the rebinding scenario can be driven without real DNS. */
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const realResolver: DnsResolver = (hostname) => lookup(hostname, { all: true });

let resolveAddresses: DnsResolver = realResolver;

/** Test seam. Never called in production. */
export function setDnsResolverForTests(resolver: DnsResolver | null): void {
  resolveAddresses = resolver ?? realResolver;
}

/**
 * Validate one URL: scheme, host, and every address the host resolves to right now.
 *
 * This is the readable pre-check — the refusal for `169.254.169.254` is a line you
 * can point at — but it is not the security boundary, and cannot be: the resolver is
 * asked again when the socket connects, and an attacker-controlled nameserver can
 * answer the two questions differently. `validatingLookup`, passed as the connection's
 * `lookup` hook, is what makes the vetted address and the connected address the same
 * one. Rejecting on *any* resolved address here remains right anyway: it refuses the
 * fetch before a socket exists rather than at connect time, which is cheaper and
 * easier to read.
 */
export async function assertFetchable(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme ${url.protocol} not allowed`);
  }
  if (isInstapaperHost(url.hostname)) {
    throw new BlockedUrlError('instapaper.com must never be fetched');
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolveAddresses(url.hostname);
  } catch {
    throw new BlockedUrlError(`cannot resolve ${url.hostname}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`cannot resolve ${url.hostname}`);

  for (const { address, family } of addresses) {
    if (addressBlocked(address, family)) {
      throw new BlockedUrlError(`${url.hostname} resolves to a blocked address`);
    }
  }
}

export interface GuardedResponse {
  url: string;
  status: number;
  body: string;
  bytes: number;
  redirects: number;
  truncatedAtCap: boolean;
}

export interface GuardedFetchOptions {
  /** `Cookie:` header value. Never logged — it is a credential. */
  cookie?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * The `lookup` hook that closes DNS rebinding: vet the address as it is chosen.
 *
 * `node:http`'s `lookup` option is the one place the resolved address and the socket
 * are guaranteed to meet — Node calls it for every address it is about to connect to,
 * including each retry of a multi-answer host. Passing `all: true` and refusing on any
 * blocked answer keeps the stronger of the two policies: the connection is refused
 * unless the host is clean in its entirety, not merely at whichever address the
 * connect loop reaches first.
 *
 * `family: 0` (on the request, not the hook) tells Node to take every answer the
 * resolver gives rather than only the family it prefers, so the veto below is applied
 * to the whole answer set, not a filtered one.
 *
 * A refused address reaches Node as a `BlockedUrlError` passed to the callback —
 * the same type `guardedFetch` throws for a pre-check refusal, so a connect-time
 * refusal is cached by the caller as permanently unresolvable rather than retried
 * as though it were a bad afternoon. Node hands the error to the request's `error`
 * event unchanged, which is what lets the type survive the trip.
 */
export function validatingLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  resolveAddresses(hostname)
    .then((answers) => {
      for (const { address, family } of answers) {
        if (addressBlocked(address, family)) {
          callback(
            new BlockedUrlError(`rebound to blocked address ${address} for ${hostname}`),
            options.all === true ? [] : '',
          );
          return;
        }
      }
      if (answers.length === 0) {
        callback(new BlockedUrlError(`cannot resolve ${hostname}`), options.all === true ? [] : '');
        return;
      }
      callback(
        null,
        options.all === true ? answers : answers[0]!.address,
        options.all === true ? undefined : answers[0]!.family,
      );
    })
    .catch((error: unknown) => {
      callback(
        error instanceof Error ? error : new Error(String(error)),
        options.all === true ? [] : '',
      );
    });
}

/**
 * Request the response for one hop, connecting through `validatingLookup`.
 *
 * **Why `node:http` and not `fetch`.** Undici (Node's `fetch`) does not expose its
 * resolver, so a validating connection cannot be built on it: a `fetch` to a rebound
 * host connects wherever the second lookup says, and no option exists to intercept
 * that. `node:http(s).request` does expose one — `lookup` — which is why this exists.
 *
 * The request is awaited to the socket, not to the body: the body is read by the
 * caller, which owns the size cap. Redirects are not followed here either — that is
 * `guardedFetch`'s job, so every hop can be re-validated.
 *
 * Injectable as a whole, like the resolver below it, because the tests that drive
 * `resolve-image` stub the network at exactly this boundary — a hand-built response
 * for a host that must never be reached for real. Stubbable hop, validating lookup:
 * the seam replaces the transport, never the vetting.
 */
export type HopRequest = typeof requestHop;

let hop: HopRequest = requestHop;

/** Test seam. Never called in production. */
export function setHopRequestForTests(replacement: HopRequest | null): void {
  hop = replacement ?? requestHop;
}

function requestHop(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions & { lookup: typeof validatingLookup } = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers,
    lookup: validatingLookup,
    // `family: 0` makes Node call the hook once with the full answer set rather than
    // once per family, so the all-answers veto is applied in one place.
    family: 0,
    ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
  };
  return new Promise((resolve, reject) => {
    const request = transport(options, (message) => resolve(message));
    request.on('error', reject);
    // The deadline signal is already racing the connection; wiring it to the request
    // too makes an abandoned socket fail fast rather than hang for its own timeout.
    signal.addEventListener('abort', () => request.destroy(new Error('timed out')), { once: true });
    request.end();
  });
}

/**
 * Fetch with redirects followed manually, so every hop is re-validated. `fetch`'s own
 * redirect handling would let a permitted URL bounce us to 169.254.169.254 unchecked.
 */
export async function guardedFetch(
  input: string | URL,
  options: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  const {
    cookie = null,
    timeoutMs = TOTAL_TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    maxRedirects = MAX_REDIRECTS,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let current = new URL(input);
  let currentCookie = cookie;
  let redirects = 0;

  for (;;) {
    await assertFetchable(current);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BlockedUrlError('timed out', false);

    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      // No language preference of our own: the article is whatever language it is, and
      // claiming English would make a Dutch or French publisher serve a translated or
      // redirected page.
      'accept-language': '*',
    };
    // Only send cookies to the host they were stored for; a redirect to another host
    // drops them rather than forwarding a session to a third party.
    if (currentCookie !== null && currentCookie !== '') headers['cookie'] = currentCookie;

    const response = await hop(current, headers, AbortSignal.timeout(remaining));
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400) {
      const location = response.headers.location ?? null;
      if (location === null) {
        return {
          url: current.toString(),
          status,
          body: '',
          bytes: 0,
          redirects,
          truncatedAtCap: false,
        };
      }
      if (redirects >= maxRedirects) throw new BlockedUrlError('too many redirects');
      const next = new URL(location, current);
      // A session never follows a cross-host redirect. Sending one publisher's cookies
      // to whatever host it bounces us to is exactly the leak this design avoids.
      if (next.hostname !== current.hostname) currentCookie = null;
      current = next;
      redirects += 1;
      continue;
    }

    const { text, bytes, cappedEarly } = await readCapped(response, maxBytes);
    return {
      url: current.toString(),
      status,
      body: text,
      bytes,
      redirects,
      truncatedAtCap: cappedEarly,
    };
  }
}

async function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ text: string; bytes: number; cappedEarly: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let cappedEarly = false;

  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      chunks.push(chunk.subarray(0, chunk.byteLength - (bytes - maxBytes)));
      cappedEarly = true;
      // Stop reading rather than leaving the server writing into a socket nobody will
      // drain — and count the bytes we chose to keep, not the ones we refused.
      response.destroy();
      break;
    }
    chunks.push(chunk);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), bytes, cappedEarly };
}
