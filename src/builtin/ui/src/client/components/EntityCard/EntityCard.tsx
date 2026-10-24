import { Badge, Box, Card, Center, Group, Image, Skeleton, Stack, Text } from '@mantine/core';
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
import { useCardFit } from '../CardGrid/cardFit.ts';
import { ENTITY_KIND_STYLES, type EntityKind, kindFill, kindGlyph } from '../../lib/entity-kind.ts';
import { HatIdenticon } from '../Identity/HatIdenticon.tsx';
import { formatRange } from '../../lib/format.ts';

/**
 * One card shape for everything that is a *thing* rather than a picture: albums,
 * auto albums, people, locations, documents.
 *
 * It is purely presentational — every caller owns its own fetching — because its
 * callers get their data different ways: an album page already has every attr
 * from one `ls -l`, a search hit has to ask.
 *
 * The cover is a fixed **aspect ratio**, not a fixed pixel height. That is what
 * lets the same card fill a 3-, 4- or 5-column grid and still read as one family,
 * which is what puts album hits in the same search grid as person hits.
 */

/** Cover box shape. Wide enough to be a picture, short enough to leave room for the text. */
const COVER_ASPECT = 3 / 2;

/** Beyond this the row wraps and cards stop being the same height for no gain. */
const MAX_LABELS = 3;

/** Leg length of the corner flag. Big enough to carry a 16px glyph clear of the diagonal. */
const FLAG_SIZE = 46;

/**
 * The corner mark that says what the card is.
 *
 * A filled triangle in the cover's top-left corner rather than a badge in the
 * text below: it sits on the picture, where the eye already is, and it is the
 * one part of a card whose position never moves — so a grid of mixed kinds can
 * be read down its left edge without reading a single title. The card's own
 * overflow clip rounds the outer point along with the card.
 */
function KindFlag({ kind }: { kind: EntityKind }) {
  const { label, icon: Icon } = ENTITY_KIND_STYLES[kind];

  return (
    <Box
      role='img'
      aria-label={label}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: FLAG_SIZE,
        height: FLAG_SIZE,
        background: kindFill(kind),
        clipPath: 'polygon(0 0, 100% 0, 0 100%)',
        pointerEvents: 'none',
      }}
    >
      <Icon size={16} stroke={2} color='white' style={{ position: 'absolute', top: 5, left: 5 }} />
    </Box>
  );
}

export type EntityCardProps = {
  title: string;
  onClick?: () => void;
  /** Cover image; falls back to `icon` on a raised surface when absent. */
  coverUrl?: string;
  /** Second source for the cover, tried when `coverUrl` fails to load. */
  coverFallbackUrl?: string;
  /**
   * What the card stands for: the corner flag, and the colour and glyph behind
   * a missing cover.
   */
  kind?: EntityKind;
  /**
   * Drawn when there is no cover, in place of the kind's own glyph. For the
   * cases where the kind is right but has more to say — a location with no
   * coordinates, an album the clusterer proposed.
   */
  icon?: ReactNode;
  /**
   * Drawn when there is no cover image, filling the cover box — a location's map.
   * Takes the location of `icon`; a cover image, once there is one, still wins.
   */
  coverArt?: ReactNode;
  /**
   * Member count, as a badge over the cover rather than a line under it.
   * Hidden when absent or 0: an album with nothing in it should say nothing,
   * not "0 items".
   */
  count?: number;
  /** ISO dates; only `timeStart` is required to render a range. */
  timeStart?: string;
  timeEnd?: string;
  description?: string;
  labels?: string[];
  /** Kind, location, pinned… — rendered before the label badges. */
  badges?: ReactNode;
  /** `title` attribute, for the full path behind a name that is not unique. */
  hoverText?: string;
  /** Buttons along the card's foot. Their clicks stay theirs and do not open the card. */
  actions?: ReactNode;
  /**
   * Goes on the card itself, not on a wrapper: the callers attach a viewport
   * observer here, and an extra div between the grid and the card would break
   * the equal-height row that `h='100%'` gives.
   */
  ref?: Ref<HTMLDivElement>;
};

export { formatRange };

export function EntityCard({
  title,
  onClick,
  coverUrl,
  coverFallbackUrl,
  kind,
  icon,
  coverArt,
  count,
  timeStart,
  timeEnd,
  description,
  labels,
  badges,
  hoverText,
  actions,
  ref,
}: EntityCardProps) {
  const range = formatRange(timeStart, timeEnd);
  // How many cover URLs have failed to load. Mantine's `Image` swaps in `fallbackSrc`
  // on the first error and then stays on it, so a second error (or a first without a
  // fallback) means there is no picture to show; the glyph takes over as if there
  // had been no cover at all. Reset when the caller hands over a new URL — a cover
  // that lands late (derivatives still generating) must get its chance.
  const [coverErrors, setCoverErrors] = useState(0);
  useEffect(() => setCoverErrors(0), [coverUrl, coverFallbackUrl]);
  const coverExhausted = coverErrors > (coverFallbackUrl ? 1 : 0);
  const shownLabels = labels?.slice(0, MAX_LABELS) ?? [];

  // Inside a CardGrid the card's height is the grid's arithmetic, not its content.
  // The text stack only grows past the card when that arithmetic came up short —
  // a badge row wrapping, mostly — so its resizes are exactly the moments to tell
  // the grid how tall this card needs to be.
  const reportFit = useCardFit();
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const text = textRef.current;
    const card = text?.parentElement;
    if (!reportFit || !text || !card) return;
    const observer = new ResizeObserver(() => {
      if (card.scrollHeight > card.clientHeight) reportFit(card.scrollHeight + card.offsetHeight - card.clientHeight);
    });
    observer.observe(text);
    return () => observer.disconnect();
  }, [reportFit]);
  const extraLabels = (labels?.length ?? 0) - shownLabels.length;

  return (
    <Card
      ref={ref}
      className='mrx-entity-card'
      radius='md'
      // Every card in a row is as tall as the tallest, so the grid stays a grid
      // however much text one of them happens to carry.
      h='100%'
      title={hoverText}
      style={{ cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
    >
      <Card.Section pos='relative'>
        <Box style={{ aspectRatio: String(COVER_ASPECT), background: 'var(--mrx-surface-raised)' }}>
          {coverUrl && !coverExhausted
            ? (
              <Image
                src={coverUrl}
                fallbackSrc={coverFallbackUrl}
                // Decorative: the title sits right under the picture, and a broken
                // image would otherwise print the alt text in the corner, under the
                // flag, where it reads as a clipped duplicate of that title.
                alt=''
                h='100%'
                w='100%'
                fit='cover'
                onError={() => setCoverErrors((n) => n + 1)}
              />
            )
            : coverArt ?? (
              // Tabler icons draw in `currentColor`, so the hue set here reaches a
              // caller's own icon as well as the kind's.
              <Center h='100%' style={{ color: kind ? kindGlyph(kind) : undefined }}>
                {icon ?? <HatIdenticon seed={`${kind ?? ''}:${title}`} label={title} />}
              </Center>
            )}
        </Box>

        {kind && <KindFlag kind={kind} />}

        {count !== undefined && count > 0 && (
          <Box
            style={{
              position: 'absolute',
              bottom: 6,
              right: 6,
              background: 'var(--mrx-scrim)',
              borderRadius: 4,
              padding: '2px 6px',
              color: 'white',
              fontSize: 12,
              fontWeight: 500,
              pointerEvents: 'none',
            }}
          >
            {count}
          </Box>
        )}
      </Card.Section>

      <Stack
        ref={textRef}
        gap={4}
        mt='sm'
        // Card is a flex column, so growing here — plus `mt='auto'` on the badge row —
        // pins the badges to the bottom. Without it they sit at a different height on
        // every card in a row, depending on which ones have a description.
        style={{ flex: 1 }}
      >
        {/* Two lines: at five columns a card is ~210px wide and one line cuts most titles mid-word. */}
        <Text fw={500} lineClamp={2}>{title}</Text>
        {range && <Text size='xs' c='dimmed'>{range}</Text>}
        {description && <Text size='xs' c='dimmed' lineClamp={2}>{description}</Text>}

        {(badges || shownLabels.length > 0) && (
          <Group gap={6} mt='auto' pt={2}>
            {badges}
            {shownLabels.map((label) => <Badge key={label} size='xs' variant='outline' color='gray'>{label}</Badge>)}
            {extraLabels > 0 && <Badge size='xs' variant='outline' color='gray'>+{extraLabels}</Badge>}
          </Group>
        )}

        {actions && (
          <Group gap={6} mt={badges || shownLabels.length > 0 ? 4 : 'auto'} pt={2} onClick={(event) => event.stopPropagation()}>
            {actions}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

/**
 * A card that has not arrived yet: the same cover box and title block as
 * `EntityCard`, so the grid keeps its shape while a page is on its way.
 */
export function EntityCardSkeleton() {
  return (
    <Card className='mrx-entity-card' radius='md' h='100%' aria-hidden>
      <Card.Section>
        <Skeleton radius={0} style={{ aspectRatio: String(COVER_ASPECT) }} />
      </Card.Section>
      <Stack gap={8} mt='sm'>
        <Skeleton height={14} width='70%' />
        <Skeleton height={10} width='40%' />
      </Stack>
    </Card>
  );
}
