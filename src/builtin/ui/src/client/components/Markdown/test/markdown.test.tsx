import { assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { rehypeCallouts, rehypeHeadingIds, rehypeKbd } from '../plugins.ts';

/** Markdown through the pipeline `Markdown` runs, without the theme around it. */
const render = (content: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeKbd, rehypeSanitize, rehypeCallouts, rehypeHeadingIds]}>{content}</ReactMarkdown>);

Deno.test('a quote opening with an alert marker is a callout, the marker gone from its text', () => {
  const html = render('> [!WARNING]\n> Stop the service **first**.\n\n> An ordinary quote.');
  assertMatch(html, /<aside data-callout="WARNING">\s*<p>Stop the service <strong>first<\/strong>.<\/p>\s*<\/aside>/);
  assertEquals(html.includes('[!WARNING]'), false);
  assertStringIncludes(html, '<blockquote>');
});

Deno.test('a marker alone on its line leaves no empty paragraph', () => {
  const html = render('> [!NOTE]\n>\n> Next paragraph.');
  assertMatch(html, /<aside data-callout="NOTE">\s*<p>Next paragraph.<\/p>\s*<\/aside>/);
});

Deno.test('headings get the anchors GitHub gives them, a repeat numbered', () => {
  const html = render('# Sign in\n\n## The `share set` command\n\n## Notes\n\n## Notes\n\n### `CFG_TRASH_RETENTION_DAYS`');
  assertMatch(html, /<h1 id="sign-in">/);
  assertMatch(html, /<h2 id="the-share-set-command">/);
  assertMatch(html, /<h2 id="notes">/);
  assertMatch(html, /<h2 id="notes-1">/);
  assertMatch(html, /<h3 id="cfg_trash_retention_days">/);
});

Deno.test('keys in <kbd> tags are keys; other HTML stays out', () => {
  const html = render('Press <kbd>Alt</kbd>+<kbd>M</kbd>, not <span onclick="x()">this</span>.');
  assertStringIncludes(html, '<kbd>Alt</kbd>+<kbd>M</kbd>');
  assertEquals(html.includes('span'), false);
  assertEquals(html.includes('onclick'), false);
});
