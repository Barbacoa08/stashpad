import { describe, expect, it } from 'vitest';
import { renderMarkdown, externalUrl } from '../../src/lib/domain/markdown';
describe('saved Markdown', () => {
  it('renders emphasis, paragraphs, nested lists, and literal code', () => {
    const html = renderMarkdown(
      '*italic* **bold** ***both***\n\n- first\n  - nested\n\n`<tag>`\n\n```js\nconst x = "<script>";\n```',
    );
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toMatch(/<em><strong>both<\/strong><\/em>/);
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain('&lt;tag&gt;');
    expect(html).toContain('code-line');
    expect(html).not.toContain('<script>');
  });
  it('keeps HTML, unknown-language code, images, and dangerous links inert', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n![private](https://tracker.invalid/pixel)\n\n[bad](javascript:alert(1)) [file](file:///tmp/x)\n\n```unknown\n<img onerror=x>\n```',
    );
    expect(html).not.toMatch(/<(script|img)\b|<[^>]+\s(?:onerror|href|src)=/);
    expect(html).toContain('&lt;img onerror=x&gt;');
    expect(html).toContain('[Image: private]');
    expect(renderMarkdown('[site](https://example.com)')).toContain(
      'data-external-url="https://example.com"',
    );
    expect(renderMarkdown('[relative](/path)')).not.toContain('<a');
  });
  it('allows only bounded explicit HTTP(S) and mailto destinations', () => {
    for (const url of [
      'https://example.com/a?q=x',
      'http://example.com',
      'mailto:joe@example.com',
    ])
      expect(externalUrl(url)).toBe(url);
    for (const url of [
      '/tmp/x',
      '//example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///tmp/x',
      'https://',
      'https://example.com\n',
      'https://' + 'a'.repeat(4096),
    ])
      expect(externalUrl(url)).toBeNull();
  });
});
