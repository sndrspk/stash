import { describe, expect, it } from 'vitest';

import { pickImage } from '../src/lib/og-image';

const PAGE = 'https://publisher.example/news/story';

const page = (head: string, body = ''): string =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('declared images', () => {
  it('takes og:image', () => {
    const html = page('<meta property="og:image" content="https://cdn.example/hero.jpg">');
    expect(pickImage(html, PAGE)).toEqual({
      imageUrl: 'https://cdn.example/hero.jpg',
      from: 'og:image',
    });
  });

  it('accepts the name= spelling, which publishers use as often as property=', () => {
    const html = page('<meta name="og:image" content="https://cdn.example/hero.jpg">');
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/hero.jpg');
  });

  it('is case-insensitive about the key', () => {
    const html = page('<meta property="OG:Image" content="https://cdn.example/hero.jpg">');
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/hero.jpg');
  });

  it('prefers og:image:secure_url over the plain tag', () => {
    const html = page(
      '<meta property="og:image" content="http://old.example/a.jpg">' +
        '<meta property="og:image:secure_url" content="https://cdn.example/b.jpg">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/b.jpg');
  });

  it('falls through og:image to twitter:image to link rel=image_src', () => {
    expect(
      pickImage(page('<meta name="twitter:image" content="https://cdn.example/t.jpg">'), PAGE),
    ).toEqual({ imageUrl: 'https://cdn.example/t.jpg', from: 'twitter:image' });

    expect(
      pickImage(page('<link rel="image_src" href="https://cdn.example/l.jpg">'), PAGE),
    ).toEqual({ imageUrl: 'https://cdn.example/l.jpg', from: 'link:image_src' });
  });

  it('resolves a relative og:image against the page', () => {
    const html = page('<meta property="og:image" content="/img/hero.jpg">');
    expect(pickImage(html, PAGE).imageUrl).toBe('https://publisher.example/img/hero.jpg');
  });

  it('resolves against <base> when the page declares one', () => {
    const html = page(
      '<base href="https://cdn.example/assets/">' + '<meta property="og:image" content="hero.jpg">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/assets/hero.jpg');
  });

  it('resolves a protocol-relative URL', () => {
    const html = page('<meta property="og:image" content="//cdn.example/hero.jpg">');
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/hero.jpg');
  });

  // A declared image is the publisher's own choice, so the furniture filter that
  // guards the <img> fallback deliberately does not apply to it.
  it('takes a declared image even when it looks like a logo', () => {
    const html = page('<meta property="og:image" content="https://cdn.example/logo.png">');
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/logo.png');
  });

  it('ignores an empty or unusable declared value and keeps looking', () => {
    const html = page(
      '<meta property="og:image" content="   ">' +
        '<meta name="twitter:image" content="https://cdn.example/t.jpg">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/t.jpg');
  });
});

describe('the <img> fallback', () => {
  it('takes the first usable image when nothing is declared', () => {
    const html = page('', '<img src="https://cdn.example/photo.jpg">');
    expect(pickImage(html, PAGE)).toEqual({
      imageUrl: 'https://cdn.example/photo.jpg',
      from: 'img',
    });
  });

  it('skips images that declare themselves small', () => {
    const html = page(
      '',
      '<img src="https://cdn.example/count.gif" width="1" height="1">' +
        '<img src="https://cdn.example/share.png" width="24" height="24">' +
        '<img src="https://cdn.example/photo.jpg" width="1200" height="800">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/photo.jpg');
  });

  it('keeps an image that declares no size at all', () => {
    // The common case for a real photograph, and the reason the size rule only
    // applies to a declared dimension.
    const html = page('', '<img src="https://cdn.example/photo.jpg">');
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/photo.jpg');
  });

  it('skips furniture by filename', () => {
    const html = page(
      '',
      '<img src="https://cdn.example/tracking-pixel.gif">' +
        '<img src="https://cdn.example/site-logo.png">' +
        '<img src="https://cdn.example/author-avatar.jpg">' +
        '<img src="https://cdn.example/badge.png">' +
        '<img src="https://cdn.example/story/photo.jpg">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/story/photo.jpg');
  });

  it('skips SVG, which is a logo every time in practice', () => {
    const html = page(
      '',
      '<img src="https://cdn.example/mark.svg"><img src="https://cdn.example/photo.jpg">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/photo.jpg');
  });

  it('never returns a data: URI', () => {
    const html = page('', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">');
    expect(pickImage(html, PAGE).imageUrl).toBeNull();
  });

  it('never returns a javascript: URL', () => {
    const html = page('<meta property="og:image" content="javascript:alert(1)">');
    expect(pickImage(html, PAGE).imageUrl).toBeNull();
  });

  it('reads past a lazy-loading placeholder to data-src', () => {
    const html = page(
      '',
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.example/real.jpg">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/real.jpg');
  });

  it('takes the largest srcset candidate when the src is a placeholder', () => {
    const html = page(
      '',
      '<img src="https://cdn.example/spacer.gif" ' +
        'srcset="https://cdn.example/small.jpg 400w, https://cdn.example/large.jpg 1600w, https://cdn.example/mid.jpg 800w">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/large.jpg');
  });

  it('reads a srcset with density descriptors', () => {
    const html = page(
      '',
      '<img srcset="https://cdn.example/1x.jpg 1x, https://cdn.example/2x.jpg 2x">',
    );
    expect(pickImage(html, PAGE).imageUrl).toBe('https://cdn.example/2x.jpg');
  });
});

describe('pages with nothing to give', () => {
  it('answers none for a page with no image at all', () => {
    expect(pickImage(page('<title>Story</title>', '<p>Words.</p>'), PAGE)).toEqual({
      imageUrl: null,
      from: 'none',
    });
  });

  it('answers none for an empty body rather than throwing', () => {
    expect(pickImage('', PAGE).imageUrl).toBeNull();
    expect(pickImage('   ', PAGE).imageUrl).toBeNull();
  });

  it('answers none for markup that is not a document', () => {
    expect(pickImage('<<<not really html', PAGE).imageUrl).toBeNull();
  });

  it('stops scanning after the first forty images', () => {
    // A gallery's later thumbnails are other articles, and a hostile page could
    // carry a hundred thousand of them.
    const filler = '<img src="https://cdn.example/logo.png">'.repeat(60);
    const html = page('', `${filler}<img src="https://cdn.example/photo.jpg">`);
    expect(pickImage(html, PAGE).imageUrl).toBeNull();
  });
});
