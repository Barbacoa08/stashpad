import MarkdownIt from 'markdown-it';
import {
  javascriptLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { classHighlighter, highlightTree } from '@lezer/highlight';

/** Links are explicit external actions, never navigation in the app WebView. */
export function externalUrl(source: string): string | null {
  if (!source || source.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(source))
    return null;
  try {
    const url = new URL(source);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol)
      ? source
      : null;
  } catch {
    return null;
  }
}
const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});
const escape = parser.utils.escapeHtml;
function highlightCode(source: string, info: string) {
  const language = info.trim().split(/\s/)[0].toLowerCase();
  const grammar = /^(js|javascript)$/.test(language)
    ? javascriptLanguage
    : /^(ts|typescript)$/.test(language)
      ? typescriptLanguage
      : language === 'json'
        ? jsonLanguage
        : null;
  const lines = [''];
  function append(text: string, classes = '') {
    text.split('\n').forEach((part, index) => {
      if (index) lines.push('');
      lines[lines.length - 1] +=
        classes && part
          ? `<span class="${classes}">${escape(part)}</span>`
          : escape(part);
    });
  }
  let cursor = 0;
  if (grammar)
    highlightTree(
      grammar.parser.parse(source),
      classHighlighter,
      (from, to, classes) => {
        append(source.slice(cursor, from));
        append(source.slice(from, to), classes);
        cursor = to;
      },
    );
  append(source.slice(cursor));
  // A multiline syntax token must close on each line before the row wrapper.
  if (source.endsWith('\n')) lines.pop();
  return lines
    .map((line) => `<span class="code-line">${line || ' '}</span>`)
    .join('');
}
parser.renderer.rules.fence = (tokens, index) =>
  `<pre class="code-block"><code>${highlightCode(tokens[index].content, tokens[index].info)}</code></pre>\n`;
parser.renderer.rules.code_block = (tokens, index) =>
  `<pre class="code-block"><code>${highlightCode(tokens[index].content, '')}</code></pre>\n`;
parser.renderer.rules.image = (tokens, index) =>
  escape(`[Image: ${tokens[index].content || 'image'}]`);
parser.renderer.rules.link_open = (tokens, index) => {
  const url = externalUrl(String(tokens[index].attrGet('href') ?? ''));
  return url
    ? `<a href="${escape(url)}" data-external-url="${escape(url)}" rel="noreferrer noopener">`
    : '<span>';
};
parser.renderer.rules.link_close = (tokens, index) => {
  // Pair with the matching opening token, including nested inline formatting.
  let depth = 1;
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].type === 'link_close') depth++;
    if (tokens[i].type === 'link_open' && --depth === 0)
      return externalUrl(String(tokens[i].attrGet('href') ?? ''))
        ? '</a>'
        : '</span>';
  }
  return '</span>';
};
export function renderMarkdown(source: string): string {
  return parser.render(source);
}
