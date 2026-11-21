import { Anchor, Box, Center, Text } from '@mantine/core';
import { DOCS_GUIDE_PATH } from '@ein/paths';
import { useEffect, useRef, useState } from 'react';
import { useGuide } from '../../hooks/useGuide.ts';
import { PageLoader } from '../Layout/PageLoader.tsx';
import { fileUrl } from '../../lib/file-url.ts';
import { guideSvg } from '../../lib/guide-svg.ts';
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

let diagrams = 0;

/** A diagram from the guide, drawn into the page so it takes the guide's fonts; its text until it is. */
function Diagram({ path, alt }: { path: string; alt: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const prefix = `guide-diagram-${++diagrams}`;
    const draw = (source: string) => {
      if (cancelled || !ref.current) return;
      const svg = source ? guideSvg(source, document, prefix, alt) : null;
      ref.current.replaceChildren(...(svg ? [svg] : []));
      setDrawn(svg !== null);
    };
    fetch(fileUrl(path))
      .then((res) => res.ok ? res.text() : '')
      .then(draw)
      .catch(() => draw(''));
    return () => {
      cancelled = true;
    };
  }, [path, alt]);
  // React leaves the first span's children alone: they are the diagram's nodes, set above.
  return (
    <>
      <span ref={ref} className='mrx-guide-diagram' style={drawn ? undefined : { display: 'none' }} />
      {!drawn && <span className='mrx-guide-diagram'>{alt}</span>}
    </>
  );
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
