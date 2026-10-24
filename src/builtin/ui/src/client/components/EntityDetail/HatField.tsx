import { type CSSProperties, Fragment, type SVGProps, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { type HatEntrance, hatEntrance, isHatEntrance } from '../../lib/hat-entrance.ts';
import { type HatFieldKind, type HatTile, layoutHatField } from '../../lib/hat-field.ts';
import type { LuminanceMap } from '../../lib/image-luminance.ts';
import { userConfig } from '../../signals/config.ts';

/** How often one tile of a field lights up, in milliseconds. */
const GLINT_EVERY = 2400;

/** Each tile's outline opacity: a shared edge, drawn by both its tiles, comes to about .36. */
const OUTLINE = .2;

/**
 * A cover's outlines: light grey over a dark part of the picture, and over a light part the
 * pattern's controls colour (`PATTERN_CONTROLS`), which is dark enough for white text and so stands
 * out on white; each at its opacity.
 */
const COVER_ON_DARK = { color: 'var(--mantine-color-gray-3)', opacity: .6 };
const COVER_ON_LIGHT_OPACITY = .95;

/** The person's settings for how a field arrives (`HAT_ENTRANCES`), and in how many ms; 0 not at all. */
const ENTRANCE_SETTING = 'CFG_USER_HEADER_ENTRANCE';
const ENTRANCE_TIME_SETTING = 'CFG_USER_HEADER_ENTRANCE_TIME';
const ENTRANCE_TIME = 450;
/** The background of the login and share-link screens arrives slower whatever the setting. */
const LOGIN_ENTRANCE_TIME = 2000;

/**
 * How long a field of `kind` takes to arrive, in ms, as the person's settings say; 0 when it does not
 * arrive: at a dialog's foot, when they give it no time, or with reduced motion.
 */
export function entranceTime(kind: HatFieldKind = 'band'): number {
  const time = kind === 'backdrop' ? LOGIN_ENTRANCE_TIME : Number(userConfig.peek()[ENTRANCE_TIME_SETTING] || ENTRANCE_TIME);
  return kind === 'foot' || !(time > 0) || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : time;
}

/** The pages a hat field is tinted for, each with its accent; a dialog's take the colour of what they are about. */
export type HatPattern = keyof typeof ACCENTS;

/**
 * One colour, or for `mixed` colour stops across the field's width. `danger` heads a dialog that
 * deletes for good, and `neutral` is the grey under a dialog's buttons.
 */
const ACCENTS = {
  album: '#339af0',
  person: '#da77f2',
  location: '#38d9a9',
  track: '#22b8cf',
  device: '#ffa94d',
  label: '#f06595',
  media: '#748ffc',
  staging: '#fcc419',
  system: '#a9e34b',
  danger: '#ff6b6b',
  neutral: '#9ba3b0',
  mixed: [[.05, '#339af0'], [.25, '#da77f2'], [.45, '#38d9a9'], [.62, '#22b8cf'], [.8, '#ffa94d'], [.98, '#f06595']],
} as const satisfies Record<string, string | readonly (readonly [number, string])[]>;

/** A pattern's accent as one colour: `mixed`'s first stop. */
export const patternAccent = (pattern: HatPattern): string => {
  const accent: string | readonly (readonly [number, string])[] = ACCENTS[pattern];
  return typeof accent === 'string' ? accent : accent[0][1];
};

/**
 * The Mantine colour of a pattern's controls, and the shade a filled one takes: the darkest of its
 * hue that white text still reads on. Patterns without one keep the app's own accent.
 */
export const PATTERN_CONTROLS: Partial<Record<HatPattern, readonly [color: string, filled: number]>> = {
  album: ['blue', 8],
  person: ['grape', 7],
  location: ['teal', 9],
  track: ['cyan', 8],
  device: ['orange', 9],
  label: ['pink', 7],
  media: ['indigo', 7],
  danger: ['red', 8],
};

/**
 * The einstein-hat field (`layoutHatField`) in `pattern`'s accent, filling its positioned parent
 * behind the parent's content: a header band, a screen's background, the foot of a
 * dialog, outlines over a cover, or the left of a band beside a cover, hiding the cover under it and
 * dissolving into it hat by hat, in place of the outlines (`kind`). Where on the tiling it is cut follows the pattern and the route.
 * Over a cover each outline is light grey where the photo under it is dark and in the pattern's
 * colour where it is light, as read from `backdrop`, the photo's luminance; grey throughout without one.
 *
 * It arrives the way and in the time the person's settings say (`hatEntrance`, `entranceTime`) the
 * first time it is laid out. From then on one of its tiles brightens and fades back every few seconds
 * (`.mrx-hat-glint`): not over a cover, with reduced motion or at a dialog's foot, nor while the page
 * is hidden.
 */
export function HatField({ pattern, kind = 'band', backdrop }: { pattern: HatPattern; kind?: HatFieldKind; backdrop?: LuminanceMap | null }) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<readonly [number, number]>();
  const { pathname } = useLocation();
  const seed = `${pattern}:${pathname}`;
  // useId's colons are not valid in a url() reference.
  const id = `mrx-hat-field-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  // Null once it has arrived, or when it shows as it is from the start.
  const [entrance, setEntrance] = useState<{ way: HatEntrance; time: number } | null>(() => {
    const time = entranceTime(kind);
    if (!time) return null;
    const chosen = userConfig.peek()[ENTRANCE_SETTING];
    return { way: isHatEntrance(chosen) ? chosen : 'drawn', time };
  });

  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((was) => was?.[0] === width && was[1] === height ? was : [width, height]);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => size && size[0] > 0 && size[1] > 0 ? layoutHatField(size[0], size[1], seed, kind, backdrop) : null,
    [size, seed, kind, backdrop],
  );

  // A ripple starts at the title, or behind the form in the middle of the login screen's background.
  const arrival = useMemo(() => {
    if (!size || !layout || !entrance) return null;
    const origin = kind === 'backdrop' ? [size[0] / 2, size[1] / 2] as const : [Math.min(90, .2 * size[0]), .45 * size[1]] as const;
    return hatEntrance(entrance.way, entrance.time, layout.tiles, size[0], size[1], layout.hatSize, origin);
  }, [size, layout, entrance, kind]);

  // Once the last tile has arrived the styles come off, which leaves every tile as it is.
  useEffect(() => {
    if (!arrival) return;
    const timer = setTimeout(() => setEntrance(null), arrival.ends + 80);
    return () => clearTimeout(timer);
  }, [arrival]);

  const glintRef = useRef<SVGGElement>(null);
  useEffect(() => {
    const group = glintRef.current;
    const tiles = layout?.tiles.filter((tile) => tile.glint).map((tile) => tile.d);
    if (!group || !tiles?.length || entrance) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const timer = setInterval(() => {
      if (document.hidden || reduced.matches) return;
      const tile = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tile.setAttribute('d', tiles[Math.floor(Math.random() * tiles.length)]);
      tile.setAttribute('class', 'mrx-hat-glint');
      tile.addEventListener('animationend', () => tile.remove());
      group.append(tile);
    }, GLINT_EVERY);
    return () => {
      clearInterval(timer);
      group.replaceChildren();
    };
  }, [layout, entrance]);

  const accent = ACCENTS[pattern];
  const paint = typeof accent === 'string' ? accent : `url(#${id}-accent)`;
  const controls = PATTERN_CONTROLS[pattern];
  const onLight = controls ? `var(--mantine-color-${controls[0]}-${controls[1]})` : patternAccent(pattern);
  const look = (tile: HatTile): SVGProps<SVGPathElement> =>
    kind === 'cover'
      ? {
        fill: 'none',
        style: {
          stroke: `color-mix(in srgb, ${onLight} ${Math.round(tile.onLight * 100)}%, ${COVER_ON_DARK.color})`,
          strokeOpacity: COVER_ON_DARK.opacity + (COVER_ON_LIGHT_OPACITY - COVER_ON_DARK.opacity) * tile.onLight,
        },
      }
      : { fill: paint, fillOpacity: tile.fill, stroke: paint, strokeOpacity: OUTLINE * tile.shade };

  return (
    <svg ref={ref} className='mrx-hat-field' data-kind={kind} viewBox={size && `0 0 ${size[0]} ${size[1]}`} aria-hidden focusable='false'>
      {size && layout && (
        <>
          {typeof accent !== 'string' && (
            <defs>
              <linearGradient id={`${id}-accent`} gradientUnits='userSpaceOnUse' x1={0} y1={0} x2={size[0]} y2={0}>
                {accent.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
              </linearGradient>
            </defs>
          )}
          {kind === 'wedge' && (
            // The whole hats' ground is one path, so no seams show the cover between them.
            <g className='mrx-hat-ground'>
              <path d={layout.tiles.filter((tile) => tile.ground === 1).map((tile) => tile.d).join('')} />
              {layout.tiles.map((tile, i) => tile.ground < 1 && <path key={i} d={tile.d} fillOpacity={tile.ground} />)}
            </g>
          )}
          {layout.tiles.map((tile, i) => {
            const enter = arrival?.tiles[i];
            const { style, ...rest } = look(tile);
            return (
              <Fragment key={i}>
                <path
                  className='mrx-hat-tile'
                  d={tile.d}
                  {...rest}
                  strokeLinejoin='round'
                  pathLength={enter?.pathLength}
                  style={{ ...style, ...enter?.style as CSSProperties | undefined }}
                />
                {enter?.flash && <path d={tile.d} fill={paint} fillOpacity={.45 * tile.shade} style={enter.flash as CSSProperties} />}
              </Fragment>
            );
          })}
          {/* The lit tiles, added and removed by the effect above; React draws no children here. */}
          <g ref={glintRef} fill={paint} fillOpacity={.4} />
        </>
      )}
    </svg>
  );
}
