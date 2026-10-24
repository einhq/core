/**
 * The EiN Mantine theme.
 *
 * Everything Mantine-facing lives here rather than in CSS overrides: component
 * surfaces come from `components.*.defaultProps`/`vars`, semantic names come from
 * `cssVariablesResolver`. theme.css carries only what a JS theme cannot express
 * (@font-face, keyframes, reduced-motion, and the non-Mantine terminal pane).
 */
import { createTheme, type CSSVariablesResolver, defaultLoaders } from '@mantine/core';
import { HatRunLoader } from '../components/Layout/HatRunLoader.tsx';
import { dark, marine, motion, semantic } from './tokens.ts';

export const theme = createTheme({
  primaryColor: 'marine',
  /** marine[5] as the filled shade — white on it clears AA (≈4.7:1). */
  primaryShade: { light: 6, dark: 5 },
  colors: { dark, marine },

  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
  headings: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontWeight: '650',
    sizes: {
      h1: { fontSize: '1.65rem', lineHeight: '1.2' },
      h2: { fontSize: '1.3rem', lineHeight: '1.25' },
      h3: { fontSize: '1.1rem', lineHeight: '1.3' },
      h4: { fontSize: '0.975rem', lineHeight: '1.35' },
    },
  },

  /**
   * A notch tighter than Mantine's defaults — the app is dense and functional. The scale
   * itself is redefined, so a call site that passes radius='md' gets it too.
   */
  defaultRadius: 'sm',
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px' },
  spacing: { xs: '0.5rem', sm: '0.6875rem', md: '0.9375rem', lg: '1.125rem', xl: '1.75rem' },
  lineHeights: { xs: '1.35', sm: '1.4', md: '1.5', lg: '1.55', xl: '1.6' },

  /**
   * Shadows are what make overlays read as floating. A box on the page has none: its raised
   * surface sets it apart, and one that is worked in (a list, a form) adds a hairline border.
   */
  shadows: {
    xs: '0 1px 2px rgba(0, 0, 0, 0.30)',
    sm: '0 2px 6px rgba(0, 0, 0, 0.35)',
    md: '0 6px 16px rgba(0, 0, 0, 0.40)',
    lg: '0 12px 28px rgba(0, 0, 0, 0.46)',
    xl: '0 20px 48px rgba(0, 0, 0, 0.55)',
  },

  respectReducedMotion: true,

  other: {
    /**
     * Media grid gutter in px, so every grid in the app agrees. A number rather than a
     * CSS variable because the justified grid computes row heights from it — the value
     * matches `spacing.xs`.
     */
    gridGutter: 3,
  },

  components: {
    /**
     * Mantine gives Paper the page's own background (`--mantine-color-body`); a raised
     * surface instead makes a card visible without a border. `withBorder` draws the hairline,
     * for a box that is worked in.
     *
     * Card renders a Paper, so this covers Card too. `vars` is merged after the
     * component's own varsResolver and lands inline, so it wins without any
     * specificity trick.
     */
    Paper: {
      defaultProps: { bg: 'var(--mrx-surface-raised)' },
      vars: () => ({ root: { '--paper-border-color': 'var(--mrx-hairline)' } }),
    },

    /**
     * Overlays sit one step above cards so a menu over a card still reads as
     * floating. Modal/Menu.Dropdown/Popover.Dropdown all render a Paper, so they
     * would otherwise inherit the card surface exactly.
     */
    Modal: {
      defaultProps: { shadow: 'xl', transitionProps: { transition: 'fade', duration: 160 } },
      styles: { content: { backgroundColor: 'var(--mrx-surface-overlay)' }, header: { backgroundColor: 'var(--mrx-surface-overlay)' } },
    },
    Popover: {
      defaultProps: { shadow: 'md', transitionProps: { transition: 'pop', duration: 140 } },
      styles: { dropdown: { backgroundColor: 'var(--mrx-surface-overlay)', border: 'none' } },
    },
    Menu: {
      defaultProps: { shadow: 'md', transitionProps: { transition: 'pop', duration: 140 } },
      styles: { dropdown: { backgroundColor: 'var(--mrx-surface-overlay)', border: 'none' } },
    },
    Tooltip: {
      defaultProps: { transitionProps: { transition: 'fade', duration: 120 } },
      styles: { tooltip: { backgroundColor: 'var(--mrx-surface-overlay)', color: 'var(--mrx-text-primary)' } },
    },

    /**
     * Pages fill the window: a media archive wants the width, for more grid columns and a
     * larger map, and the content stays against the sidebar it hangs off. Horizontal padding
     * is AppShell's job (`padding='md'` on the shell), so the container adds none and the
     * content has one edge, which the header's search box aligns against.
     */
    Container: { defaultProps: { fluid: true, px: 0 } },

    /** Inputs are a raised surface with no outline until focused. */
    TextInput: { defaultProps: { variant: 'filled' } },
    PasswordInput: { defaultProps: { variant: 'filled' } },
    Textarea: { defaultProps: { variant: 'filled' } },
    Select: { defaultProps: { variant: 'filled' } },
    NumberInput: { defaultProps: { variant: 'filled' } },

    /** Dividers are hairlines. */
    Divider: { defaultProps: { color: 'var(--mrx-hairline)' } },

    /**
     * Cards carry their own surface, so they need no shadow — two depth cues on one
     * element make a dark UI look muddy.
     */
    Card: { defaultProps: { shadow: 'none', padding: 'md' } },

    Button: {
      defaultProps: { fw: 600 },
      styles: { root: { transition: 'background-color var(--mrx-dur-fast) var(--mrx-ease), border-color var(--mrx-dur-fast) var(--mrx-ease)' } },
    },

    /** Icon buttons default to secondary text, so a row of them is not a row of glare. */
    ActionIcon: {
      defaultProps: { variant: 'subtle', color: 'gray' },
      styles: { root: { transition: 'background-color var(--mrx-dur-fast) var(--mrx-ease), color var(--mrx-dur-fast) var(--mrx-ease)' } },
    },

    Badge: { defaultProps: { radius: 'sm', fw: 600 } },

    /** Links are one of the few places the accent is allowed to be a colour. */
    Anchor: { defaultProps: { c: 'var(--mrx-accent)', underline: 'hover' } },

    /** Every loader, a loading button's included, is the hat with a third of its outline running round. */
    Loader: { defaultProps: { loaders: { ...defaultLoaders, hat: HatRunLoader }, type: 'hat' } },

    /** Rows separate by hairline, and only the header rule is allowed to be visible. */
    Table: {
      defaultProps: { verticalSpacing: 'xs', horizontalSpacing: 'sm' },
      styles: {
        th: { color: 'var(--mrx-text-tertiary)', fontWeight: 600, borderColor: 'var(--mrx-hairline)' },
        td: { borderColor: 'var(--mrx-hairline)' },
      },
    },

    Tabs: {
      styles: {
        tab: { transition: 'color var(--mrx-dur-fast) var(--mrx-ease), border-color var(--mrx-dur-fast) var(--mrx-ease)' },
        list: { borderColor: 'var(--mrx-hairline)' },
      },
    },

    /** The control itself is the sunken track; the active pill is the raised surface, or the `color` prop's colour when one is given. */
    SegmentedControl: {
      defaultProps: { radius: 'sm' },
      styles: {
        root: { backgroundColor: 'var(--mrx-surface-sunken)' },
        indicator: { backgroundColor: 'var(--sc-color, var(--mrx-surface-overlay))' },
      },
    },

    Alert: { defaultProps: { radius: 'sm', variant: 'light' } },

    Accordion: { defaultProps: { variant: 'filled' } },
  },
});

/**
 * Maps the semantic `--mrx-*` names onto the document, and retargets two Mantine
 * variables:
 *
 * - `--mantine-color-default-border` is the hairline every input/table/divider
 *   uses, so lightening it here thins the whole app at once.
 * - `--mantine-color-dimmed` is the secondary text colour.
 *
 * `light` is left empty: the app is dark-only, and this is where a light scheme would go.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: { ...motion },
  dark: {
    ...semantic.dark,
    '--mantine-color-default-border': semantic.dark['--mrx-hairline'],
    '--mantine-color-dimmed': semantic.dark['--mrx-text-secondary'],
  },
  light: {},
});
