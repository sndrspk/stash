/**
 * Does this text look like an excerpt rather than an article?
 *
 * It used to decide whether to fetch the publisher's page ourselves, which is why it
 * reads as a question about worth. Stash no longer fetches, and nothing acts on the
 * answer any more: `plainText` is what the render-time cleaner needs, and `isTruncated`
 * survives because `fixtures.ts` reports it when capturing a page, which is how you tell
 * a fixture of a stub from a fixture of an article.
 *
 * Kept rather than deleted for that reason alone. Pure and side-effect-free, so it costs
 * nothing to keep and is trivially unit-tested.
 */

/** Below this many characters of plain text, assume we were served an excerpt. */
export const MIN_FULL_LENGTH = 1500;

/**
 * Phrases that mean "there is more of this elsewhere".
 *
 * Keep this list short. An over-eager phrase produces false positives on every article
 * that happens to contain it — and unlike the length signal, a phrase can appear in a
 * perfectly complete article's related-links furniture. Nothing acts on the verdict now,
 * so a false positive costs a misleading line in a fixture manifest rather than anything
 * a reader sees.
 */
export const SENTINELS = ['read more', 'continue reading'] as const;

export interface TruncationVerdict {
  truncated: boolean;
  /** Short human-readable signals, for the fixture manifest to report. */
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
