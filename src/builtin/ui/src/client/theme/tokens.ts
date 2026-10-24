/**
 * Design tokens.
 *
 * The app is dark-only, but every value a component reads is a *semantic* name
 * (`--mrx-surface-raised`, not `--mantine-color-dark-6`), so adding a light
 * scheme later means filling in the `light` branch of the resolver in theme.ts
 * rather than editing components.
 *
 * Depth model: chrome recedes, content rises, media sits deepest. A card is
 * legible because it is *lighter* than the page, not because it is outlined, and
 * near-black does not read as gloomy.
 */
import type { MantineColorsTuple } from '@mantine/core';

/**
 * Neutral scale, very slightly cool. Index positions are not free: Mantine's dark
 * scheme maps them to fixed roles (see the table below), so the ordering here is
 * load-bearing and the scale must stay monotonic.
 *
 *   0 text-primary      4 hairline / default-border   8 chrome (header, navbar)
 *   2 text-secondary    5 hover / overlay surface     9 sunken (media canvas)
 *   3 placeholder       6 raised (cards, inputs)
 *                       7 body background
 */
export const dark: MantineColorsTuple = [
  '#e8ecf1',
  '#c9cfd8',
  '#9ba3b0',
  '#6c7480',
  '#333844',
  '#262a33',
  '#1d2027',
  '#16181d',
  '#101217',
  '#0a0b0e',
];

/**
 * Accent. Luminous enough to carry against a near-black surface, and used sparingly: focus, active nav, links, selection.
 * Large areas are never accent-coloured; the photographs supply the colour.
 *
 * Contrast on the body surface (#16181d): marine[4] as text ≈ 5.6:1, white on a
 * marine[5] fill ≈ 4.7:1 — both clear AA.
 */
export const marine: MantineColorsTuple = [
  '#e7f1ff',
  '#c6deff',
  '#9cc6ff',
  '#6faafb',
  '#4a90f0',
  '#2b70d6',
  '#1f5fc0',
  '#184ba0',
  '#153c80',
  '#102a57',
];

/** Semantic surface/text/accent names, per colour scheme. */
export const semantic = {
  dark: {
    '--mrx-surface-sunken': dark[9],
    '--mrx-surface-chrome': '#070a10',
    '--mrx-surface-base': dark[7],
    '--mrx-surface-raised': dark[6],
    '--mrx-surface-overlay': dark[5],
    '--mrx-hairline': dark[4],
    '--mrx-text-primary': dark[0],
    '--mrx-text-secondary': dark[2],
    '--mrx-text-tertiary': dark[3],
    '--mrx-accent': marine[4],
    '--mrx-accent-strong': marine[5],
    /** Backdrop for photo/video pixels — the deepest surface in the app. */
    '--mrx-media-bg': dark[9],
    /** Scrim for labels drawn on top of media (duration pills, face labels). */
    '--mrx-scrim': 'rgba(0, 0, 0, 0.72)',
  },
} as const;

/**
 * Motion. One easing and three durations, so timing stays consistent and
 * `prefers-reduced-motion` is a single override in theme.css rather than an audit.
 */
export const motion = {
  '--mrx-dur-fast': '120ms',
  '--mrx-dur-base': '180ms',
  '--mrx-dur-slow': '260ms',
  /** Decelerating — movement arrives and settles rather than easing symmetrically. */
  '--mrx-ease': 'cubic-bezier(0.2, 0, 0, 1)',
} as const;
