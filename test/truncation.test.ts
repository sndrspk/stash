import { describe, expect, it } from 'vitest';
import { MIN_FULL_LENGTH, isTruncated, plainText } from '../src/lib/truncation.js';

const long = (chars = MIN_FULL_LENGTH + 500): string => 'word '.repeat(Math.ceil(chars / 5));

describe('plainText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(plainText('<p>Hello   <b>there</b></p>\n<p>you</p>')).toBe('Hello there you');
  });

  it('drops script and style bodies entirely', () => {
    expect(plainText('<p>a</p><script>var x = "hidden";</script><style>p{color:red}</style>')).toBe('a');
  });

  it('decodes the entities that affect length most', () => {
    expect(plainText('<p>a&nbsp;&amp;&nbsp;b</p>')).toBe('a & b');
  });
});

describe('isTruncated', () => {
  it('flags text under the length threshold', () => {
    const verdict = isTruncated('<p>Too short.</p>');
    expect(verdict.truncated).toBe(true);
    expect(verdict.reasons).toContain(`under ${MIN_FULL_LENGTH} chars`);
  });

  it('passes a long article with no sentinels', () => {
    const verdict = isTruncated(`<p>${long()}</p>`);
    expect(verdict.truncated).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('flags a sentinel phrase regardless of length', () => {
    const verdict = isTruncated(`<p>${long()} Continue reading</p>`);
    expect(verdict.truncated).toBe(true);
    expect(verdict.reasons).toContain('"continue reading"');
  });

  it('matches sentinels case-insensitively', () => {
    expect(isTruncated(`<p>${long()} READ MORE</p>`).truncated).toBe(true);
  });

  // "[…]" mid-paragraph is ordinary elision; at the end it is a cut.
  it('flags a trailing ellipsis but not an embedded one', () => {
    expect(isTruncated(`<p>${long()} […]</p>`).reasons).toContain('ends with an ellipsis');
    expect(isTruncated(`<p>She said […] and left. ${long()}</p>`).truncated).toBe(false);
  });

  it('reports the character count it judged', () => {
    expect(isTruncated('<p>abc</p>').chars).toBe(3);
  });

  it('accepts a caller-supplied threshold', () => {
    expect(isTruncated('<p>abc</p>', 2).truncated).toBe(false);
  });
});
