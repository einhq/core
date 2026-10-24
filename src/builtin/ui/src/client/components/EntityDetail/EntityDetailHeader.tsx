import { Avatar, Box, Group, Image, type MantineColor, Stack, Text, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { isValidElement, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCover } from '../../hooks/useCover.ts';
import { useAppHeaderHeight } from '../../hooks/useHeaderHeight.ts';
import { usePhone } from '../../hooks/usePhone.ts';
import { usePageSubject } from '../../hooks/usePageSubject.ts';
import { SurfaceContext } from '../../hooks/useSurface.ts';
import { DISPLAY_DERIVATIVE, GRID_NAME } from '../../lib/derivatives.ts';
import { imageLuminance, type LuminanceMap } from '../../lib/image-luminance.ts';
import { CoverAvatar } from '../Cover/CoverAvatar.tsx';
import { UploadDropzone } from '../Upload/UploadDropzone.tsx';
import { userConfig } from '../../signals/config.ts';
import { stuckHeaderHeight } from '../../signals/stuck-header.ts';
import { FloatingControls } from './FloatingControls.tsx';
import { ActionsMenu, CornerActions, type PageActions, useActionGroups } from './HeaderActions.tsx';
import { entranceTime, HatField, type HatPattern } from './HatField.tsx';

/** Between the stuck row's own content and the name at its start or ⋮ at its end, in px. */
const END_GAP = 12;

/** The person's setting for how the field meets a cover: `split` or `lines`. */
const COVER_SETTING = 'CFG_USER_HEADER_COVER';

export type EntityDetailHeaderProps = {
  /** Node that owns the optional `coverPhoto` softlink. Omit for a generic page header. */
  path?: string;
  /** Brief context displayed immediately above the entity's title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /**
   * What the page is called, for the code outside it that asks (`usePageSubject`). Only a title
   * drawn by a component of its own needs it: the text of the others is read from `title`.
   */
  name?: string;
  /** Avatar content used until an entity cover loads. Omit when the header needs no avatar. */
  fallback?: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  /** What can be done to what the page shows, in the header's corner (`PageActions`). */
  actions?: PageActions;
  /**
   * How the page's list is narrowed and ordered: under the title, or at the right end of `tabs`'
   * row. On a phone, once the header has scrolled away — all of it, or all but `tabs` — they float
   * over the page's foot instead (`FloatingControls`).
   */
  controls?: ReactNode;
  /**
   * Centred at the top of the header, with the title and controls kept at its
   * foot. For what the page is *of* rather than how its list is narrowed — the
   * timeline's year.
   */
  top?: ReactNode;
  /**
   * Straddles the header's bottom edge, lined up with its content: half over the
   * header, half over the page. It sits outside the header's box, whose
   * `overflow: hidden` would otherwise cut it in two — the timeline's slider,
   * whose track is the header's lower border.
   */
  edge?: ReactNode;
  /**
   * The page's `Tabs.List`, standing on the header's bottom edge: the selected
   * tab takes the page's own surface, so it reads as the top of the panel below
   * it. The page wraps header and panels in one `Tabs`, which the list finds by
   * context. The `controls` stand at the row's right end. Not with `edge`, which holds the same edge.
   */
  tabs?: ReactNode;
  /**
   * Part of the background: over the cover or pattern and its shade, under the
   * title and controls, filling the content area down to the bottom edge. It
   * takes no pointer input — the content in front of it would have it anyway.
   * The timeline's histogram, standing on the slider in `edge`.
   */
  backdrop?: ReactNode;
  coverColor?: MantineColor;
  coverSize?: number;
  /** Keep hero content in normal flow so control-heavy generic headers can grow on mobile. */
  flowContent?: boolean;
  /**
   * Drawn when the node has no cover image, as both the background and the
   * avatar — a location's map, the same picture its card shows. A cover image,
   * once there is one, still wins.
   */
  coverArt?: ReactNode;
  /**
   * The einstein-hat field (`HatField`): the whole background of a coverless header, in the page's
   * accent, and outlines fading in from the left over a cover, coloured by how light the photo under
   * them is. As the person's `CFG_USER_HEADER_COVER` says, the field may instead take the left of a
   * header with a cover for its own (`split`), dissolving into the photo beside it.
   */
  pattern?: HatPattern;
};

/** The text written out in a node's elements; what a component draws from its own props is not. */
const textOf = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
};

/**
 * What a page with this header is called: `name` when one is given, else the text written out in
 * `title`. A title a component of its own draws holds no text to read — the staging page's category
 * switcher — and says its name with `name` instead.
 */
const headerName = ({ title, name }: { title: ReactNode; name?: string }): string => (name ?? textOf(title)).replace(/\s+/g, ' ').trim();

/**
 * The common identity band for a person, album, location, track or device, and
 * the matching visual header for pages without an owning VFS node.
 *
 * Drawing the entity's cover here makes it clear which object the details, map and media below
 * belong to, while its fallback preserves a useful shape before a cover exists.
 *
 * Scrolled down, a page's header stays on screen as its last row under the app header — the
 * tabs, else the controls, else the title (`useStuckHeader`). At the row's right end it keeps ⋮
 * with every action in it. The page's name slides in at its left, pushing the row's own content
 * aside, where the row has the width for it; not on a phone, where the row needs it and the
 * reader knows where they are. On a phone the controls leave that row and float over the page's
 * foot instead (`FloatingControls`), so a header without tabs scrolls away whole.
 *
 * It also declares the page's subject (`usePageSubject`): the page's name, the subtitle's text and
 * `path`, which the chat is told when asked about the page. A page whose title is drawn by a
 * component of its own names itself with `name`, since there is no text here to read.
 */
export function EntityDetailHeader({
  path,
  eyebrow,
  title,
  name,
  fallback,
  subtitle,
  meta,
  actions,
  controls,
  top,
  edge,
  tabs,
  backdrop,
  coverColor,
  coverSize,
  flowContent,
  coverArt,
  pattern,
}: EntityDetailHeaderProps) {
  useSignals();
  const cover = useCover(path ?? '', Boolean(path), { rendition: DISPLAY_DERIVATIVE.photo, fallbackRendition: GRID_NAME, sourcePhoto: true });
  const avatarSize = coverSize ?? 144;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const openUpload = useRef<() => void>(null);
  const openFolder = useRef<() => void>(null);
  const groups = useActionGroups(actions, openUpload, openFolder);
  const hasActions = groups.some((group) => group.length > 0);
  // A route in a dialog or drawer scrolls in its own box, under no app header.
  const onPage = useContext(SurfaceContext) === null;
  const shown = headerName({ title, name });
  usePageSubject({ title: shown || undefined, about: textOf(subtitle).replace(/\s+/g, ' ').trim().slice(0, 200), node: path });
  const phone = usePhone();
  const floating = onPage && phone && Boolean(controls);
  const row = tabs ? 'tabs' : controls && !floating ? 'controls' : 'title';
  const rowRef = { tabs: tabsRef, controls: controlsRef, title: titleRef }[row];
  const sticks = onPage && !(floating && !tabs);
  const startShown = sticks && row !== 'title';
  const endShown = sticks && hasActions;
  useStuckHeader(sticks, edge ? frameRef : headerRef, headerRef, rowRef, contentRef, startShown ? startRef : null, endShown ? endRef : null);
  const contentGone = useContentGone(floating, contentRef);
  // Only once the cover is known to be absent, so a location with a photo does not
  // flash its map first.
  const art = coverArt && (!path || (cover.loaded && !cover.coverUrl)) ? coverArt : null;
  const hasCover = Boolean(cover.coverUrl || art);
  const split = hasCover && userConfig.value[COVER_SETTING] !== 'lines';
  // The photo waits, hidden, until it has been read; then the fields over it arrive (`HatField`) while
  // it fades in, in the same time.
  const read = useCoverRead(cover.coverUrl);
  const [photoArrival] = useState(() => entranceTime());
  const overCover = hasCover && (art || read);
  // A key per photo, so a page that swaps its node without remounting has the new one arrive too.
  const fieldKey = read?.url ?? 'art';

  // A cover is drawn once, sharp across the band. A person keeps the square beside it: there it is a
  // face crop, and the band the photo it was cut from.
  const avatar = fallback === undefined || (cover.coverUrl && pattern !== 'person')
    ? null
    : art
    ? <Box className='mrx-entity-header-art-avatar' w={avatarSize} h={avatarSize}>{art}</Box>
    : path
    ? <CoverAvatar path={path} alt={shown || undefined} size={avatarSize} radius='md' color={coverColor} eager fallback={fallback} />
    : <Avatar size={avatarSize} radius='md' color={coverColor}>{fallback}</Avatar>;

  const header = (
    <Box
      ref={headerRef}
      component='header'
      className='mrx-entity-header mrx-pattern'
      data-has-cover={path || art ? Boolean(cover.coverUrl || art) : undefined}
      data-flow-content={flowContent || undefined}
      data-pattern={pattern}
      data-split={split || undefined}
      data-has-top={top ? true : undefined}
      data-has-edge={edge ? true : undefined}
      data-has-tabs={tabs ? true : undefined}
      data-has-avatar={avatar ? true : undefined}
      data-has-actions={hasActions || undefined}
      data-has-backdrop={backdrop ? true : undefined}
      data-float-controls={floating || undefined}
      data-row={row}
    >
      {cover.coverUrl && (
        <Image
          className='mrx-entity-header-background'
          src={cover.coverUrl}
          fallbackSrc={cover.coverFallbackUrl}
          alt=''
          aria-hidden
          style={read ? { animation: `mrx-hat-appear ${photoArrival}ms ease-out both` } : { opacity: 0 }}
        />
      )}
      {art && <Box className='mrx-entity-header-background' aria-hidden>{art}</Box>}
      <Box className='mrx-entity-header-shade' />
      {pattern && !hasCover && (!path || cover.loaded) && <HatField pattern={pattern} />}
      {pattern && overCover && !split && <HatField key={`cover:${fieldKey}`} pattern={pattern} kind='cover' backdrop={read?.luminance} />}
      {pattern && overCover && split && <HatField key={`wedge:${fieldKey}`} pattern={pattern} kind='wedge' />}
      {backdrop && <Box className='mrx-entity-header-backdrop' aria-hidden>{backdrop}</Box>}
      {hasActions && (
        <Box className='mrx-entity-header-actions'>
          <CornerActions groups={groups} />
        </Box>
      )}
      {startShown && (
        <Box ref={startRef} className='mrx-entity-header-start'>
          <Text className='mrx-entity-header-start-title' truncate='end'>{title}</Text>
        </Box>
      )}
      {endShown && (
        <Box ref={endRef} className='mrx-entity-header-end'>
          <ActionsMenu groups={groups} />
        </Box>
      )}
      {actions?.upload && <UploadDropzone {...actions.upload} openRef={openUpload} openFolderRef={openFolder} />}

      <Group ref={contentRef} className='mrx-entity-header-content' align='flex-end' wrap='nowrap' gap='lg'>
        {avatar && <Box className='mrx-entity-header-avatar'>{avatar}</Box>}
        <Stack gap={6} className='mrx-entity-header-copy'>
          {top && <Box className='mrx-entity-header-top'>{top}</Box>}
          {eyebrow}
          <Title ref={titleRef} order={1} c='white' style={{ minWidth: 0 }}>{title}</Title>
          {subtitle && <Box className='mrx-entity-header-subtitle'>{subtitle}</Box>}
          {meta}
          {controls && !tabs && (
            <Group ref={controlsRef} className='mrx-entity-header-controls' justify='flex-end' gap='xs' wrap='wrap'>
              {controls}
            </Group>
          )}
        </Stack>
      </Group>
      {tabs && (
        <Group ref={tabsRef} className='mrx-header-tabs' justify='space-between' align='flex-end' gap='xs' wrap='nowrap'>
          <Box className='mrx-header-tabs-list'>{tabs}</Box>
          {controls && <Group className='mrx-header-tabs-controls' gap='xs' wrap='nowrap'>{controls}</Group>}
        </Group>
      )}
    </Box>
  );

  const floated = floating && <FloatingControls shown={contentGone}>{controls}</FloatingControls>;

  if (!edge) {
    return (
      <>
        {header}
        {floated}
      </>
    );
  }

  return (
    <Box ref={frameRef} className='mrx-entity-header-frame'>
      {header}
      <Box className='mrx-entity-header-edge'>{edge}</Box>
      {floated}
    </Box>
  );
}

/**
 * Whether the header's content, less its padding — the title and the controls under it — has
 * gone under the app header: scrolled off, or, with tabs, under the app header as the header
 * sticks at its tab row.
 */
function useContentGone(enabled: boolean, contentRef: RefObject<HTMLElement | null>): boolean {
  const appHeader = useAppHeaderHeight();
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    if (!enabled || !content) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const below = parseFloat(getComputedStyle(content).paddingBottom) || 0;
      setGone(content.getBoundingClientRect().bottom - below <= appHeader + 1);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    globalThis.addEventListener('resize', onScroll);
    return () => {
      globalThis.removeEventListener('scroll', onScroll);
      globalThis.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [enabled, contentRef, appHeader]);

  return enabled && gone;
}

/** The cover photo at `url` and its luminance (`imageLuminance`), once it has loaded; undefined until then. */
function useCoverRead(url: string | undefined): { url: string; luminance: LuminanceMap | null } | undefined {
  const [read, setRead] = useState<{ url: string; luminance: LuminanceMap | null }>();
  useEffect(() => {
    if (!url) return;
    let live = true;
    imageLuminance(url).then((luminance) => {
      if (live) setRead({ url, luminance });
    });
    return () => {
      live = false;
    };
  }, [url]);
  return read?.url === url ? read : undefined;
}

/**
 * Keeps a page's header on screen as `row`, its last row: the header — the frame, when it has an
 * edge — sticks (`data-sticky`) with its top `--mrx-header-above` over the app header's foot, so
 * all above the row, less as much band as the content keeps below it, goes on under the app header.
 * The row's height is `stuckHeaderHeight`, and `--mrx-stuck-header-height` on the document, for
 * what measures against the top of the window.
 *
 * While the page scrolls, `--mrx-header-hidden` says how much of the header is under the app
 * header, so the backdrop can shrink into what shows; the header has `data-stuck` once only the
 * row is left. The row's place in the header (`--mrx-header-row-top`, `--mrx-header-row-height`)
 * is where `start`, the stuck header's name, and `end`, its ⋮, stand; `--mrx-header-start` and
 * `--mrx-header-end` are the room the row leaves them at its left and right ends.
 */
function useStuckHeader(
  enabled: boolean,
  stickyRef: RefObject<HTMLElement | null>,
  headerRef: RefObject<HTMLElement | null>,
  rowRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  startRef: RefObject<HTMLElement | null> | null,
  endRef: RefObject<HTMLElement | null> | null,
) {
  const appHeader = useAppHeaderHeight();

  useLayoutEffect(() => {
    const sticky = stickyRef.current;
    const header = headerRef.current;
    const row = rowRef.current;
    if (!enabled || !sticky || !header || !row) return;
    const root = document.documentElement;
    sticky.setAttribute('data-sticky', '');
    let above = 0;
    let frame = 0;

    const follow = () => {
      frame = 0;
      const hidden = Math.min(above, Math.max(0, appHeader - sticky.getBoundingClientRect().top));
      sticky.style.setProperty('--mrx-header-hidden', `${hidden}px`);
      header.toggleAttribute('data-stuck', above > 0 && hidden >= above - 1);
    };
    const place = () => {
      const content = contentRef.current;
      const below = content ? parseFloat(getComputedStyle(content).paddingBottom) || 0 : 0;
      above = Math.max(0, Math.round(row.getBoundingClientRect().top - sticky.getBoundingClientRect().top - below));
      const height = sticky.offsetHeight - above;
      sticky.style.setProperty('--mrx-header-above', `${above}px`);
      const rowBox = row.getBoundingClientRect();
      header.style.setProperty('--mrx-header-row-top', `${rowBox.top - header.getBoundingClientRect().top}px`);
      header.style.setProperty('--mrx-header-row-height', `${rowBox.height}px`);
      // Nothing shown at an end, a phone's name or a row without actions, takes no room.
      const start = startRef?.current?.getBoundingClientRect().width ?? 0;
      header.style.setProperty('--mrx-header-start', `${start > 0 ? start + END_GAP : 0}px`);
      const end = endRef?.current?.getBoundingClientRect().width ?? 0;
      header.style.setProperty('--mrx-header-end', `${end > 0 ? end + END_GAP : 0}px`);
      root.style.setProperty('--mrx-stuck-header-height', `${height}px`);
      stuckHeaderHeight.value = height;
      follow();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(follow);
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(sticky);
    observer.observe(row);
    if (startRef?.current) observer.observe(startRef.current);
    if (endRef?.current) observer.observe(endRef.current);
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      globalThis.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      observer.disconnect();
      sticky.removeAttribute('data-sticky');
      header.removeAttribute('data-stuck');
      for (const name of ['--mrx-header-above', '--mrx-header-hidden']) sticky.style.removeProperty(name);
      for (const name of ['--mrx-header-row-top', '--mrx-header-row-height', '--mrx-header-start', '--mrx-header-end']) header.style.removeProperty(name);
      root.style.removeProperty('--mrx-stuck-header-height');
      stuckHeaderHeight.value = 0;
    };
  }, [enabled, stickyRef, headerRef, rowRef, contentRef, startRef, endRef, appHeader]);
}
