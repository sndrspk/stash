/**
 * Is this text worth fetching the full page for?
 *
 * Ported from SanFeedBin's Truncation (docs/EXTRACTION.md). Pure and side-effect-free —
 * no I/O, so it is trivially unit-tested. In SanFeedBin this ran over a feed's excerpt;
 * in Stash it runs over whatever Instapaper's get_text returned, asking the same question.
 */

/** Below this many characters of plain text, assume we were served an excerpt. */
export const MIN_FULL_LENGTH = 1500;

/**
 * Phrases that mean "there is more of this elsewhere".
 *
 * Keep this list short. An over-eager phrase produces false positives on every article
 * that happens to contain it — and unlike the length signal, a phrase can appear in a
 * perfectly complete article's related-links furniture. The cost of a false positive is
 * one wasted fetch, not a wrong render, because the extraction is compared before it is
 * used.
 */
export const SENTINELS = ['read more', 'continue reading'] as const;

export interface TruncationVerdict {
  truncated: boolean;
  /** Short human-readable signals, for the failure tag and the probe's output. */
  reasons: string[];
  chars: number;
}

/** Strip tags and collapse whitespace. Deliberately crude — this feeds a heuristic. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two ORed signals: too short, or a sentinel phrase. `[…]` counts only when it ends the
 * text — mid-paragraph it is ordinary elision, at the end it is a cut.
 */
export function isTruncated(html: string, minLength: number = MIN_FULL_LENGTH): TruncationVerdict {
  const text = plainText(html);
  const chars = text.length;
  const reasons: string[] = [];

  if (chars < minLength) reasons.push(`under ${minLength} chars`);

  const lower = text.toLowerCase();
  for (const sentinel of SENTINELS) {
    if (lower.includes(sentinel)) reasons.push(`"${sentinel}"`);
  }

  if (/(\[\s*(?:…|\.\.\.)\s*\]|…)\s*$/.test(text)) reasons.push('ends with an ellipsis');

  return { truncated: reasons.length > 0, reasons, chars };
}
