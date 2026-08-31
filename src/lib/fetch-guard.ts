/**
 * Guarded outbound fetch.
 *
 * Both the image resolver and the extractor fetch a URL that ultimately came from a
 * third party, from inside our own infrastructure. That is textbook SSRF exposure, so
 * every hop is validated: scheme, resolved address, redirect target, response size and
 * a wall-clock deadline.
 *
 * Used by the probe today and by the serverless functions later — same rules in both.
 */

import { lookup } from 'node:dns/promises';

export const USER_AGENT = 'Stash/0.1 (+https://github.com/sndrspk/stash)';

/** SanFeedBin's numbers: short, because this runs unattended during a sync. */
export const CONNECT_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 15_000;
/** Node's fetch does not split connect from read, so the deadline is the sum. */
export const TOTAL_TIMEOUT_MS = CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS;

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 5 * 1024 * 1024;

export class BlockedUrlError extends Error {}

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

/**
 * Validate one URL: scheme, host, and every address the host resolves to. Rejecting on
 * *any* resolved address (rather than the one we happen to connect to) is what closes
 * the DNS-rebinding gap.
 */
export async function assertFetchable(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme ${url.protocol} not allowed`);
  }
  if (isInstapaperHost(url.hostname)) {
    throw new BlockedUrlError('instapaper.com must never be fetched');
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
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
  userAgent?: string;
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
    userAgent = USER_AGENT,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let current = new URL(input);
  let currentCookie = cookie;
  let redirects = 0;

  for (;;) {
    await assertFetchable(current);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BlockedUrlError('timed out');

    const headers: Record<string, string> = {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en;q=0.9',
    };
    // Only send cookies to the host they were stored for; a redirect to another host
    // drops them rather than forwarding a session to a third party.
    if (currentCookie !== null && currentCookie !== '') headers['cookie'] = currentCookie;

    const response = await fetch(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) {
        return { url: current.toString(), status: response.status, body: '', bytes: 0, redirects, truncatedAtCap: false };
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
      status: response.status,
      body: text,
      bytes,
      redirects,
      truncatedAtCap: cappedEarly,
    };
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; cappedEarly: boolean }> {
  const body = response.body;
  if (body === null) return { text: '', bytes: 0, cappedEarly: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let cappedEarly = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (bytes - maxBytes)));
      cappedEarly = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), bytes, cappedEarly };
}
