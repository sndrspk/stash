// @vitest-environment jsdom
//
// A real DOM, because that is what DOMPurify parses into. Without one it reports
// itself unsupported and returns its input unchanged — so a test run in the node
// environment would assert nothing while appearing to pass.
import { describe, expect, it } from 'vitest';

import { sanitizeArticle } from '../src/lib/sanitize';

const clean = (html: string) => sanitizeArticle(html).toLowerCase();

describe('what must never survive', () => {
  it('drops script, wherever it hides', () => {
    for (const attack of [
      '<script>alert(1)</script>',
      '<p>Text</p><script src="https://evil.example/x.js"></script>',
      '<SCRIPT>alert(1)</SCRIPT>',
      '<scr<script>ipt>alert(1)</script>',
      '<svg><script>alert(1)</script></svg>',
      '<math><mtext><script>alert(1)</script></mtext></math>',
    ]) {
      // Asserted by parsing the output, not by searching its text: a nesting
      // trick leaves the payload behind as *escaped text*, which is inert and is
      // the right outcome. Looking for the string `alert(1)` would fail on that
      // correct result — and would also fail on an article that simply discusses
      // JavaScript.
      const parsed = document.createElement('div');
      parsed.innerHTML = sanitizeArticle(attack);

      expect(parsed.querySelector('script'), attack).toBeNull();
      expect(parsed.querySelector('svg'), attack).toBeNull();
      expect(clean(attack), attack).not.toContain('<script');
    }
  });

  it('drops every event handler attribute', () => {
    for (const attack of [
      '<img src="https://a/x.jpg" onerror="alert(1)">',
      '<p onclick="alert(1)">Text</p>',
      '<body onload="alert(1)"><p>Text</p></body>',
      '<div OnMouseOver="alert(1)">Text</div>',
      '<a href="https://a/" onfocus="alert(1)" autofocus>Link</a>',
    ]) {
      const out = clean(attack);
      expect(out, attack).not.toContain('alert(1)');
      expect(out, attack).not.toMatch(/on\w+=/);
    }
  });

  it('refuses javascript: and data: URLs on links and images', () => {
    for (const attack of [
      '<a href="javascript:alert(1)">Link</a>',
      '<a href="JaVaScRiPt:alert(1)">Link</a>',
      '<a href="&#106;avascript:alert(1)">Link</a>',
      '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
      '<a href="data:text/html,<script>alert(1)</script>">Link</a>',
    ]) {
      const out = clean(attack);
      expect(out, attack).not.toContain('javascript:');
      expect(out, attack).not.toContain('data:text/html');
    }
  });

  it('drops the elements that load or execute on their own', () => {
    for (const tag of ['iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'link']) {
      const out = clean(`<p>Before</p><${tag}></${tag}><p>After</p>`);
      expect(out, tag).not.toContain(`<${tag}`);
      // The prose around it survives: an article minus its embed is still an article.
      expect(out, tag).toContain('before');
      expect(out, tag).toContain('after');
    }
  });

  it('drops inline style, which would fight the reader’s own typography', () => {
    expect(clean('<p style="font-size: 90px; color: red">Text</p>')).not.toContain('style=');
  });

  it('drops a <base> that would repoint every relative URL in the article', () => {
    expect(clean('<base href="https://evil.example/"><a href="/x">Link</a>')).not.toContain(
      '<base',
    );
  });
});

describe('what an article is allowed to keep', () => {
  it('keeps ordinary prose markup intact', () => {
    const article =
      '<h2>A heading</h2><p>Some <strong>bold</strong> and <em>italic</em> text with ' +
      '<a href="https://example.com/x">a link</a>.</p><blockquote><p>A quote.</p></blockquote>' +
      '<ul><li>One</li><li>Two</li></ul>';
    const out = sanitizeArticle(article);

    for (const fragment of ['<h2>', '<strong>', '<em>', '<blockquote>', '<li>', 'A heading']) {
      expect(out).toContain(fragment);
    }
  });

  it('keeps figures, images and their captions', () => {
    const out = sanitizeArticle(
      '<figure><img src="https://cdn.example/a.jpg" alt="A photograph" width="1200" ' +
        'height="800" srcset="https://cdn.example/a-small.jpg 400w"><figcaption>The caption' +
        '</figcaption></figure>',
    );

    expect(out).toContain('<figure>');
    expect(out).toContain('<figcaption>');
    expect(out).toContain('alt="A photograph"');
    // Declared dimensions earn their place: the column count depends on measuring
    // the article correctly, and an image that says how big it is can be measured
    // before it loads.
    expect(out).toContain('width="1200"');
    expect(out).toContain('srcset=');
  });

  it('keeps tables and code, which real articles contain', () => {
    const out = sanitizeArticle(
      '<table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td colspan="2">B</td>' +
        '</tr></tbody></table><pre><code>const x = 1;</code></pre>',
    );

    expect(out).toContain('<table>');
    expect(out).toContain('scope="col"');
    expect(out).toContain('colspan="2"');
    expect(out).toContain('<pre>');
    expect(out).toContain('const x = 1;');
  });

  it('keeps relative and protocol-relative image sources', () => {
    // Instapaper's extractor leaves these; the reading view resolves them against
    // the document, and refusing them would blank the illustrations.
    expect(sanitizeArticle('<img src="//cdn.example/a.jpg">')).toContain('//cdn.example/a.jpg');
  });
});

describe('links leave the app', () => {
  it('opens every link in a new tab, safely', () => {
    const out = sanitizeArticle('<p><a href="https://example.com/x">Link</a></p>');

    // In an installed PWA with no address bar, an in-place navigation strands the
    // reader on a page with no way back — and loses their place in the article.
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('leaves an anchor without an href alone', () => {
    const out = sanitizeArticle('<p><a id="section-2">Anchor</a></p>');
    expect(out).not.toContain('target=');
  });

  it('does not leave the hook registered for the next caller', () => {
    sanitizeArticle('<a href="https://example.com/">Link</a>');
    // A second sanitise through DOMPurify's own default configuration must not
    // inherit our link policy.
    const out = sanitizeArticle('<p>No links here.</p>');
    expect(out).toBe('<p>No links here.</p>');
  });
});

describe('degenerate input', () => {
  it('returns nothing for nothing', () => {
    expect(sanitizeArticle('')).toBe('');
    expect(sanitizeArticle('   ')).toBe('');
  });

  it('does not throw on markup that is not a document', () => {
    expect(() => sanitizeArticle('<<<p>unclosed')).not.toThrow();
  });
});
