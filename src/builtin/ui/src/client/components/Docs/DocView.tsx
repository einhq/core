import { Anchor, Box, Center, Text } from '@mantine/core';
import { DOCS_GUIDE_PATH } from '@ein/paths';
import { useEffect, useState } from 'react';
import { useGuide } from '../../hooks/useGuide.ts';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { fileUrl } from '../../lib/file-url.ts';
import { GUIDE_ROOT, GUIDE_SITE, guideDir, guideRoute, liveRoute, resolveGuidePath } from '../../lib/guide.ts';
import { Markdown } from '../Markdown/Markdown.tsx';
import { useScrollToHash } from './reference.tsx';

/** A URL with an explicit scheme (http:, mailto:, …) or protocol-relative. */
const isExternal = (url: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

/**
 * A page's links: to another page of the guide, or to the live page of what the site's generated
 * reference pages list; a web address opens in a new tab. Anything else in the site's tree is not
 * bundled, so it stays text.
 */
const guideLink = (dir: string, modules: string[]) => (href: string): string | null | undefined => {
  if (isExternal(href)) return undefined;
  const [path, hash = ''] = href.split('#');
  const target = resolveGuidePath(dir, decodeURIComponent(path));
  if (target === null || !/\.md$/i.test(target)) return null;
  return liveRoute(target, hash, modules) ?? guideRoute(target, hash);
};

/** A file a page names by a relative path, in the bundle: `../../assets/shots/x.webp` from `guide/` is `assets/shots/x.webp`. */
const bundleFile = (dir: string, src: string): string | null => {
  const path = resolveGuidePath(dir ? `docs/${dir}` : 'docs', decodeURIComponent(src));
  return path === null ? null : `${DOCS_GUIDE_PATH}/${path}`;
};

/**
 * An SVG diagram made safe to draw into the page: no scripts, no handlers, no `javascript:` links;
 * its ids prefixed so two diagrams on a page keep their own gradients and markers; its own size
 * given up to the page's CSS, and labelled for a screen reader.
 */
function inlineSvg(source: string, prefix: string, label: string): string | null {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg' || doc.querySelector('parsererror')) return null;
  svg.querySelectorAll('script, foreignObject').forEach((element) => element.remove());
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || (/href$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value))) element.removeAttribute(attribute.name);
    }
  }
  const ids = [...svg.querySelectorAll('[id]')].map((element) => element.id);
  let text = new XMLSerializer().serializeToString(svg);
  for (const id of ids) {
    const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text
      .replace(new RegExp(`(\\sid=")${quoted}"`, 'g'), `$1${prefix}-${id}"`)
      .replace(new RegExp(`url\\(#${quoted}\\)`, 'g'), `url(#${prefix}-${id})`)
      .replace(new RegExp(`((?:xlink:)?href=")#${quoted}"`, 'g'), `$1#${prefix}-${id}"`);
  }
  const escaped = label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return text.replace(
    /<svg\b([^>]*)>/,
    (_, attributes: string) => `<svg${attributes.replace(/\s(width|height|role|aria-label)="[^"]*"/g, '')} role="img" aria-label="${escaped}">`,
  );
}

let diagrams = 0;

/** A diagram from the guide, drawn into the page so it takes the guide's fonts. */
function Diagram({ path, alt }: { path: string; alt: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const prefix = `guide-diagram-${++diagrams}`;
    fetch(fileUrl(path))
      .then((res) => res.ok ? res.text() : '')
      .then((source) => !cancelled && setSvg(source ? inlineSvg(source, prefix, alt) : null))
      .catch(() => !cancelled && setSvg(null));
    return () => {
      cancelled = true;
    };
  }, [path, alt]);
  // Trusted markup only: a file of the read-only bundle, with scripts and handlers taken out above.
  return svg ? <span className='mrx-guide-diagram' dangerouslySetInnerHTML={{ __html: svg }} /> : <span className='mrx-guide-diagram'>{alt}</span>;
}

/**
 * A picture in a page, as a figure with its caption: a diagram drawn inline, a screenshot with its
 * 2x file for a sharp screen, opening at full size. Spans throughout, since a paragraph holds it.
 */
function GuideImage({ dir, src, alt, title }: { dir: string; src: string; alt: string; title?: string }) {
  const path = isExternal(src) ? null : bundleFile(dir, src);
  if (!path) return <>{alt}</>;
  const double = path.replace(/(\.\w+)$/, '@2x$1');
  const shot = /\/assets\/shots\/[^/]+\.webp$/.test(path);
  return (
    <span className='mrx-guide-figure'>
      {path.endsWith('.svg') ? <Diagram path={path} alt={alt} /> : (
        <a href={fileUrl(shot ? double : path)} target='_blank' rel='noreferrer'>
          <img src={fileUrl(path)} srcSet={shot ? `${fileUrl(path)} 1x, ${fileUrl(double)} 2x` : undefined} alt={alt} loading='lazy' decoding='async' />
        </a>
      )}
      {title && <span className='mrx-guide-caption'>{title}</span>}
    </span>
  );
}

/** A page of the guide, by its path under the guide's `docs/` (`shell/ssh-sftp.md`), at the heading the URL's hash names. */
export function DocView({ page }: { page: string }) {
  const { guide } = useGuide();
  const [loaded, setLoaded] = useState<{ page: string; content: string | null }>();

  useEffect(() => {
    let cancelled = false;
    fetch(fileUrl(`${GUIDE_ROOT}/${page}`))
      .then(async (res) => !cancelled && setLoaded({ page, content: res.ok ? await res.text() : null }))
      .catch(() => !cancelled && setLoaded({ page, content: null }));
    return () => {
      cancelled = true;
    };
  }, [page]);

  const content = loaded?.page === page ? loaded.content : undefined;
  useScrollToHash(typeof content === 'string');

  if (content === undefined) return <PageLoader />;

  if (content === null) {
    return (
      <Center py='xl'>
        <Text c='dimmed'>
          The guide has no page {page}. It is also at <Anchor href={GUIDE_SITE} target='_blank' rel='noreferrer'>einhq.eu/docs</Anchor>.
        </Text>
      </Center>
    );
  }

  const dir = guideDir(page);
  return (
    <Box maw={820} className='mrx-guide'>
      <Markdown
        content={content}
        headingIds
        link={guideLink(dir, guide?.modules ?? [])}
        renderImage={(image) => <GuideImage dir={dir} {...image} />}
      />
    </Box>
  );
}
