/**
 * Per-host cookie storage and replay.
 *
 * Ported from SanFeedBin's SiteCookieStore / PersistedCookieJar (docs/EXTRACTION.md).
 * Deliberately lossy: only `name=value` pairs survive. Secure, HttpOnly, Path, Expires
 * and SameSite are dropped. Every target is TLS, cookies sit at the root, and expiry is
 * enforced server-side — when a session dies, extraction falls back to the public text.
 */

/** A host → `Cookie:` header value map. In production this is the encrypted KV store. */
export type SessionStore = Record<string, string>;

/**
 * Lowercase a host and strip the leading dots and the root-label trailing dot.
 * `.Example.COM.` → `example.com`
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A hostname: dot-separated labels, or an IP literal. No scheme, path, or punctuation. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Turn what someone typed into a hostname, or return null.
 *
 * Accepts a bare host or any URL containing one, because pasting the article URL you were
 * just looking at is the obvious thing to do. Rejects anything else rather than storing a
 * session under a key no request will ever match — a typo would otherwise fail silently,
 * which is the worst possible outcome for a credential store.
 */
export function coerceHost(input: string): string | null {
  const raw = stripControlChars(input).trim();
  if (raw === '') return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const host = normalizeHost(new URL(raw).hostname);
      return HOSTNAME.test(host) ? host : null;
    } catch {
      return null;
    }
  }

  // A bare host, possibly with a path or port stuck to it.
  const host = normalizeHost(raw.split('/')[0]?.split('?')[0]?.split('#')[0]?.replace(/:\d+$/, '') ?? '');
  return HOSTNAME.test(host) ? host : null;
}

/**
 * Collapse CR, LF, TAB and any other C0/C1 control character to a single space.
 *
 * A header copied out of DevTools routinely carries a newline, and a control character
 * in a request header is a header-injection bug at worst and a rejected request at best.
 * Written as an explicit codepoint scan rather than a regex: the escapes for this range
 * are easy to get subtly wrong, and this cannot be.
 */
export function stripControlChars(value: string): string {
  let out = '';
  let gap = false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (isControl) {
      gap = out !== '';
      continue;
    }
    if (gap) {
      out += ' ';
      gap = false;
    }
    out += ch;
  }
  return out;
}

/**
 * RFC 6265 domain matching, and nothing looser.
 *
 * A cookie saved for host H is sent to request host U only when U === H, or U ends with
 * ".H". The dot is the whole point: without it `fakenytimes.com` matches `nytimes.com`,
 * and one publisher's session goes to another host. A bare `endsWith` or `includes` here
 * is a vulnerability, not a style question.
 *
 * Two guards beyond the RFC rule, both cheap:
 *   - An IP literal matches only itself. `1.2.3.4` must never suffix-match anything.
 *   - A single-label host (`com`, `localhost`) matches only itself, so a saved `com`
 *     cannot claim every `.com` request.
 *
 * Not implemented: the public suffix list, which would also stop a saved `co.uk` from
 * matching `bbc.co.uk`. Real cookie jars need it because a remote server chooses the
 * Domain attribute. Here the host is typed by the person who owns the session, so the
 * threat is a typo rather than a hostile Set-Cookie, and the PSL is not worth carrying.
 */
export function domainMatches(urlHost: string, savedHost: string): boolean {
  const u = normalizeHost(urlHost);
  const s = normalizeHost(savedHost);
  if (u === '' || s === '') return false;
  if (u === s) return true;
  // IP literals have no domain hierarchy, so suffix matching is meaningless for them.
  // Guard both sides: a saved `168.1.1` is not a valid literal but would otherwise
  // dot-suffix-match the host `192.168.1.1`.
  if (IPV4.test(u) || u.includes(':') || IPV4.test(s) || s.includes(':')) return false;
  if (!s.includes('.')) return false; // single-label: exact only
  return u.endsWith(`.${s}`);
}

/**
 * Parse a raw `Cookie:` header value into name → value pairs.
 *
 * Tolerates what a person actually pastes: a leading `Cookie:` label, stray whitespace,
 * embedded newlines, and values containing `=` (split on the first one only, never all
 * of them).
 */
export function parseCookieHeader(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = stripControlChars(raw).trim().replace(/^cookie\s*:\s*/i, '');
  for (const part of body.split(';')) {
    const chunk = part.trim();
    if (chunk === '') continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue; // no name, or no `=` at all
    const name = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    // A cookie name cannot contain whitespace (RFC 6265 §4.1.1). Enforcing that keeps a
    // tab-separated table paste from being misread as one malformed cookie.
    if (name === '' || /\s/.test(name)) continue;
    out.set(name, value); // last wins, matching the store's merge rule
  }
  return out;
}

/**
 * The DevTools *cookie table* — Application → Cookies, select rows, copy — which is the
 * thing people reach for first, and which is tab-separated `name value domain …`.
 *
 * Not the documented path, but recovering from it costs ten lines and saves a dead end.
 */
export function parseCookieTable(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('\t')) continue;
    const fields = line.split('\t');
    const name = (fields[0] ?? '').trim();
    const value = (fields[1] ?? '').trim();
    if (name === '' || /\s/.test(name)) continue;
    if (name.toLowerCase() === 'name') continue; // the table's own header row
    out.set(name, value);
  }
  return out;
}

export type CookieInputFormat = 'header' | 'table' | 'empty' | 'unrecognised';

export interface ParsedCookieInput {
  cookies: Map<string, string>;
  format: CookieInputFormat;
  /** A safe description of what arrived. Never includes a cookie value. */
  hint: string;
}

/**
 * Parse whatever someone actually pasted, and say what it was — so a wrong paste can be
 * diagnosed instead of merely refused.
 */
export function parseCookieInput(raw: string): ParsedCookieInput {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { cookies: new Map(), format: 'empty', hint: 'nothing arrived on stdin' };
  }

  const header = parseCookieHeader(raw);
  if (header.size > 0) {
    return { cookies: header, format: 'header', hint: `${header.size} cookies` };
  }

  const table = parseCookieTable(raw);
  if (table.size > 0) {
    return { cookies: table, format: 'table', hint: `${table.size} cookies from a pasted cookie table` };
  }

  // Nothing usable. Describe the shape without echoing anything that might be a secret.
  const chars = trimmed.length;
  let shape = `${chars} characters with no name=value pairs`;
  if (/^https?:\/\//i.test(trimmed)) shape = 'a URL';
  else if (trimmed.startsWith('{') || trimmed.startsWith('[')) shape = 'JSON';
  else if (!trimmed.includes('=')) shape = `${chars} characters containing no "=" at all`;
  return { cookies: new Map(), format: 'unrecognised', hint: shape };
}

/** Render name → value pairs back into a `Cookie:` header value. */
export function serializeCookies(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Merge an incoming header value over an existing one, last-wins per name.
 * A blank incoming value is a no-op, never a wipe — backing out of a sign-in must not
 * destroy a session captured earlier. Clearing is a separate, explicit action.
 */
export function mergeCookieHeaders(existing: string, incoming: string): string {
  const next = parseCookieHeader(incoming);
  if (next.size === 0) return existing;
  const merged = parseCookieHeader(existing);
  for (const [name, value] of next) merged.set(name, value);
  return serializeCookies(merged);
}

/**
 * The `Cookie:` header to send with a request to `url`, or null when no stored host
 * matches. When several hosts match (an apex and a subdomain both stored), the most
 * specific wins.
 */
export function cookieHeaderFor(url: string | URL, store: SessionStore): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const matches = Object.keys(store)
    .filter((saved) => domainMatches(host, saved))
    .sort((a, b) => normalizeHost(b).length - normalizeHost(a).length);

  const best = matches[0];
  if (best === undefined) return null;
  const header = store[best];
  return header === undefined || header.trim() === '' ? null : header;
}

/**
 * The cookie names a stored header carries. Names only — values are credentials and
 * must never be logged, printed, or returned to a client.
 */
export function cookieNames(header: string): string[] {
  return [...parseCookieHeader(header).keys()];
}
