import { Alert, Typography } from '@mantine/core';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { HighlightedCode } from '../CodeEditor/HighlightedCode.tsx';
import { CALLOUTS, type HastNode, rehypeCallouts, rehypeHeadingIds, rehypeKbd, textOf } from './plugins.ts';

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
  /** Draws an image itself, in place of `image`: a figure with its caption, a diagram drawn inline. */
  renderImage?: (image: { src: string; alt: string; title?: string }) => ReactNode;
  /** Each heading gets an id as GitHub makes it, so a link to `page.md#a-heading` lands on it. */
  headingIds?: boolean;
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

const defaultLink = (href: string): string | null | undefined => href.startsWith('/') ? href : /^(https?|mailto):/i.test(href) ? undefined : null;

/**
 * Markdown, sanitized: GitHub's flavour (tables, task lists, alerts, `<kbd>` keys), code blocks highlighted (a
 * fence without a language as a command line). What its links and images may reach is the
 * caller's: docs resolve them against their directory, an assistant reply only to the archive's
 * pages.
 */
export function Markdown({ content, className, link, image, renderImage, headingIds = false, breaks = false }: MarkdownProps) {
  return (
    <Typography className={className}>
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={headingIds ? [rehypeKbd, rehypeSanitize, rehypeCallouts, rehypeHeadingIds] : [rehypeKbd, rehypeSanitize, rehypeCallouts]}
        components={{
          aside({ node, children }) {
            const callout = CALLOUTS[String((node as HastNode | undefined)?.properties?.dataCallout ?? '')];
            if (!callout) return <aside>{children}</aside>;
            return <Alert variant='light' color={callout.color} title={callout.title} my='md' className='mrx-callout'>{children}</Alert>;
          },
          img({ node: _node, src, alt, ...rest }) {
            if (renderImage && typeof src === 'string' && src) return renderImage({ src, alt: alt ?? '', title: rest.title });
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
