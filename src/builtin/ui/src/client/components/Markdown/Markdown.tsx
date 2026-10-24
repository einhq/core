import { Typography } from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { HighlightedCode } from '../CodeEditor/HighlightedCode.tsx';

export type MarkdownProps = {
  /** Markdown source text. */
  content: string;
  className?: string;
  /**
   * Where a link goes: a route of the app (navigated in place), `null` for none (its text is
   * shown as text), or `undefined` for the default — a web or mail address opens in a new tab,
   * an absolute path is a route of the app, anything else is text.
   */
  link?: (href: string) => string | null | undefined;
  /** The URL an image loads from, or `null` to show its alt text instead. Without it no image loads. */
  image?: (src: string) => string | null;
  /**
   * Text a person typed, such as a description: every line break is kept, as in a comment on
   * GitHub, and so is a legacy `<br>` (see `withLineBreaks`), so plain text reads as it was written.
   */
  breaks?: boolean;
};

/**
 * Line breaks as the legacy import wrote them — an HTML `<br>` in plain text —
 * become real ones, so the text reads the same as a description typed today.
 */
export const withLineBreaks = (text: string) => text.replace(/<br\s*\/?>/gi, '\n');

/** The text of a hast element, which is all a code block holds once sanitized. */
type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const textOf = (node: HastNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('');

const defaultLink = (href: string): string | null | undefined => href.startsWith('/') ? href : /^(https?|mailto):/i.test(href) ? undefined : null;

/**
 * Markdown, sanitized: GitHub's flavour (tables, task lists), code blocks highlighted (a fence
 * without a language as a command line). What its links and images may reach is the caller's:
 * docs resolve them against their directory, an assistant reply only to the archive's pages.
 */
export function Markdown({ content, className, link, image, breaks = false }: MarkdownProps) {
  return (
    <Typography className={className}>
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          img({ node: _node, src, alt, ...rest }) {
            const resolved = typeof src === 'string' && src && image ? image(src) : null;
            if (!resolved) return <>{alt ?? ''}</>;
            return <img {...rest} src={resolved} alt={alt ?? ''} style={{ maxWidth: '100%' }} />;
          },
          pre({ node, children }) {
            const code = (node as HastNode | undefined)?.children?.find((child) => child.tagName === 'code');
            if (!code) return <pre>{children}</pre>;
            const classes = code.properties?.className;
            const language = (Array.isArray(classes) ? classes.map(String) : []).find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? '';
            return <HighlightedCode code={textOf(code).replace(/\n$/, '')} language={language} />;
          },
          a({ node: _node, href, children, ...rest }) {
            const raw = typeof href === 'string' ? href : '';
            if (!raw) return <>{children}</>;
            if (raw.startsWith('#')) return <a {...rest} href={raw}>{children}</a>;
            let target = link?.(raw);
            if (target === undefined) target = defaultLink(raw);
            if (target === undefined) {
              return (
                <a {...rest} href={raw} target='_blank' rel='noreferrer'>
                  {children}
                </a>
              );
            }
            if (target === null) return <>{children}</>;
            return <Link to={target}>{children}</Link>;
          },
        }}
      >
        {breaks ? withLineBreaks(content) : content}
      </ReactMarkdown>
    </Typography>
  );
}
