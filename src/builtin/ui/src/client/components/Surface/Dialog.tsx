import { Box, Modal, type ModalProps, useMantineTheme } from '@mantine/core';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { usePhone } from '../../hooks/usePhone.ts';
import { navigatePage, onPageChange, pageLocation, pageNavigating } from '../../signals/module-ui.ts';
import { HatField, type HatPattern, PATTERN_CONTROLS, patternAccent } from '../EntityDetail/HatField.tsx';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { bindScrollbar } from '../Layout/scrollbar.ts';

/**
 * A dialog's widths, each for a kind of content, so the box is wider than it is tall: `sm` a
 * question to confirm or one field, `md` a confirmation with choices or a short form, `lg` a form
 * whose fields stand two to a row, `xl` a map or a tool. `screen` is the screen less a margin, as
 * tall as it is wide, for a page's worth of content that still reads as a dialog over the page: its
 * edge and corners stay in sight, so what it hides is still there to step back to.
 */
const SIZES = { sm: 460, md: 560, lg: 700, xl: 920 } as const;

export type DialogSize = keyof typeof SIZES | 'screen';

export type DialogProps = Omit<ModalProps, 'title' | 'size' | 'padding' | 'withCloseButton' | 'radius'> & {
  title: ReactNode;
  /** A Tabler icon name, drawn in a tile before the title. */
  icon?: string;
  /** A line under the title: where, or of what, the dialog is. */
  subtitle?: ReactNode;
  /** Beside the title, before the close button: badges, a count. */
  aside?: ReactNode;
  /** The header's field and the controls' colour: the pattern of the pages of what the dialog is about. */
  pattern?: HatPattern;
  size?: DialogSize | number | string;
  /** Stays a floating box on a phone, for a dialog that only asks to confirm; any other fills the screen there. */
  floating?: boolean;
  /** The body without padding, for content that runs to the dialog's edges: a map, a grid. */
  bleed?: boolean;
  /**
   * In place of the icon, title and subtitle, a taller band of the dialog's own: About's mark and
   * name. The title is still the dialog's name, read out but not shown.
   */
  hero?: ReactNode;
  /**
   * What the dialog stands on: `raised`, a step above the page, for fields and lists, which are
   * lighter again; `base`, the page's own, for one that holds cards, which are raised.
   */
  ground?: 'raised' | 'base';
  /** Given, the body is a form: Enter in a field, or a `type='submit'` button, calls it. */
  onSubmit?: () => void;
  /**
   * `false` leaves Back to whoever opened it: the shell's dialog, whose frame is drawn again
   * when its route has loaded, and which `DialogHost` makes a history entry of once.
   */
  backCloses?: boolean;
};

/** The variables Mantine gives each colour beside its ten shades. */
const VARIANTS = ['light', 'light-hover', 'light-color', 'outline', 'outline-hover', 'text'];

/**
 * The primary colour's variables pointed at the pattern's colour on the content box, so everything
 * inside that would have been the app's accent — a focused field's border, a checkbox, the submit
 * button — follows the kind without each control being told. A control given no colour asks for the
 * primary colour by name (`--mantine-color-<primary>-filled`), so those are the ones re-pointed, as
 * well as the `--mantine-primary-color-*` that Mantine's stylesheets read.
 */
const controlColors = (pattern: HatPattern, primary: string): Record<string, string> => {
  const controls = PATTERN_CONTROLS[pattern];
  if (!controls) return {};
  const [color, filled] = controls;
  const of = (variant: number | string) => `var(--mantine-color-${color}-${variant})`;
  const fill = of(filled);
  const hover = filled < 9 ? of(filled + 1) : `color-mix(in srgb, ${of(9)}, #000 18%)`;
  const vars: Record<string, string> = {
    [`--mantine-color-${primary}-filled`]: fill,
    [`--mantine-color-${primary}-filled-hover`]: hover,
    '--mantine-primary-color-filled': fill,
    '--mantine-primary-color-filled-hover': hover,
  };
  for (const variant of VARIANTS) vars[`--mantine-color-${primary}-${variant}`] = of(variant);
  for (const variant of ['light', 'light-hover', 'light-color']) vars[`--mantine-primary-color-${variant}`] = of(variant);
  for (let n = 0; n <= 9; n++) vars[`--mantine-color-${primary}-${n}`] = vars[`--mantine-primary-color-${n}`] = of(n);
  return vars;
};

/** The bar of buttons, where `DialogActions` is the body's last child. */
const barOf = (body: HTMLElement): HTMLElement | null => body.querySelector<HTMLElement>(':scope > .mrx-dialog-actions, :scope > .mrx-dialog-form > .mrx-dialog-actions');

/**
 * The dialog's scrollbar, the page's kind (`bindScrollbar`): over the body's right edge from under
 * the header to above the bar of buttons, which stand outside what scrolls and over it. Its length
 * follows the bar's height, and the scroll's length whatever the body holds.
 */
function DialogScrollbar({ body }: { body: HTMLElement | null }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!body || !track || !thumb) return;
    const fit = () => (track.style.bottom = `${barOf(body)?.offsetHeight ?? 0}px`);
    return bindScrollbar(track, thumb, {
      element: body,
      events: body,
      // The scroll's length is what the body holds: its children, a form's when it is one. Which
      // children there are changes as a route loads or a dialog moves between its steps.
      watch: (changed) => {
        const resized = new ResizeObserver(() => {
          fit();
          changed();
        });
        const added = new MutationObserver(() => observe());
        const observe = () => {
          resized.disconnect();
          resized.observe(body);
          added.observe(body, { childList: true });
          for (const child of body.children) {
            resized.observe(child);
            if (!child.classList.contains('mrx-dialog-form')) continue;
            added.observe(child, { childList: true });
            for (const inner of child.children) resized.observe(inner);
          }
          fit();
          changed();
        };
        observe();
        return () => {
          resized.disconnect();
          added.disconnect();
        };
      },
    });
  }, [body]);

  return (
    <div ref={trackRef} className='mrx-scrollbar mrx-dialog-scrollbar' aria-hidden>
      <div ref={thumbRef} className='mrx-scrollbar-thumb' />
    </div>
  );
}

/** How many dialogs a history entry holds open, in its state: none for an entry without one. */
const DIALOGS_KEY = 'dialogs';

const dialogsOf = (state: unknown): number => {
  const count = state && typeof state === 'object' ? (state as Record<string, unknown>)[DIALOGS_KEY] : undefined;
  return typeof count === 'number' ? count : 0;
};

/**
 * On a phone an open dialog is a history entry, as the drawer is there (`openDrawer`): opening it
 * pushes the page's own location with one more open dialog in its state, so Back — a phone's back
 * gesture above all — closes it rather than leaving the page beneath it. Closed any other way, it
 * steps back off its entry, unless the page is already leaving for another (a link in it).
 */
export function useBackCloses(active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const location = pageLocation();
    if (!active || !location) return;
    const depth = dialogsOf(location.state) + 1;
    const state = location.state && typeof location.state === 'object' ? location.state : {};
    navigatePage({ pathname: location.pathname, search: location.search, hash: location.hash }, { state: { ...state, [DIALOGS_KEY]: depth } });
    let backed = false;
    const unsubscribe = onPageChange((now, action) => {
      if (backed || action !== 'POP' || pageNavigating() || dialogsOf(now.state) >= depth) return;
      backed = true;
      close.current();
    });
    return () => {
      unsubscribe();
      if (!backed && !pageNavigating() && dialogsOf(pageLocation()?.state) === depth) navigatePage(-1);
    };
  }, [active]);
}

/**
 * The shell's dialog: a header band over the einstein-hat field in the colour of what it is about,
 * as that thing's pages have — its icon, title and close button standing on it — and the body
 * below. `DialogActions` as the body's last child is the bar of buttons across its foot. Only the
 * body scrolls, between the two, with the page's kind of scrollbar; a floating dialog has a hairline
 * edge against the dimmed page.
 *
 * With `onSubmit` the body is a form whose actions are still the bar.
 *
 * On a phone it fills the screen, unless `floating`, and its buttons and fields are larger to
 * touch, with 16 px text in a field, which a phone's browser otherwise zooms in on, and Back
 * closes it (`useBackCloses`).
 */
export function Dialog(
  {
    title,
    icon,
    subtitle,
    aside,
    pattern = 'mixed',
    size = 'md',
    floating = false,
    bleed = false,
    hero,
    ground = 'raised',
    onSubmit,
    backCloses = true,
    fullScreen,
    className,
    children,
    ...props
  }: DialogProps,
) {
  const phone = usePhone();
  const { primaryColor } = useMantineTheme();
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useBackCloses(backCloses && phone && props.opened, props.onClose);
  return (
    <Modal
      centered
      {...props}
      size={size === 'screen' ? '100%' : typeof size === 'string' && size in SIZES ? SIZES[size as keyof typeof SIZES] : size}
      xOffset={size === 'screen' ? 'var(--mantine-spacing-xl)' : props.xOffset}
      yOffset={size === 'screen' ? 'var(--mantine-spacing-xl)' : props.yOffset}
      fullScreen={fullScreen ?? (phone && !floating)}
      data-screen={size === 'screen' || undefined}
      withCloseButton={false}
      padding={0}
      radius='md'
      className={className ? `mrx-dialog ${className}` : 'mrx-dialog'}
      data-phone={phone || undefined}
      styles={{
        // The content box holds the header and the body and does not scroll itself; the body does.
        content: {
          ...controlColors(pattern, primaryColor),
          '--mrx-dialog-ground': ground === 'base' ? 'var(--mrx-surface-base)' : 'var(--mrx-surface-raised)',
          background: 'var(--mrx-dialog-ground)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        } as CSSProperties,
        body: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 },
      }}
    >
      <Box
        component='header'
        className='mrx-dialog-header'
        data-hero={hero ? true : undefined}
        style={{ '--mrx-dialog-accent': patternAccent(pattern) } as CSSProperties}
      >
        <HatField pattern={pattern} />
        {hero
          ? (
            <>
              <Modal.Title className='mrx-dialog-unseen-title'>{title}</Modal.Title>
              <Box className='mrx-dialog-hero'>{hero}</Box>
            </>
          )
          : (
            <>
              {icon && (
                <Box className='mrx-dialog-icon'>
                  <TablerIcon name={icon} size={20} stroke={1.75} />
                </Box>
              )}
              <Box className='mrx-dialog-heading'>
                <Modal.Title className='mrx-dialog-title'>{title}</Modal.Title>
                {subtitle && <Box className='mrx-dialog-subtitle'>{subtitle}</Box>}
              </Box>
              {aside && <Box className='mrx-dialog-aside'>{aside}</Box>}
            </>
          )}
        <Modal.CloseButton className='mrx-dialog-close' size='lg' />
      </Box>
      <Box className='mrx-dialog-frame'>
        <Box ref={setBody} className='mrx-dialog-body' data-bleed={bleed || undefined}>
          {onSubmit
            ? (
              <form
                className='mrx-dialog-form'
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmit();
                }}
              >
                {children}
              </form>
            )
            : children}
        </Box>
        <DialogScrollbar body={body} />
      </Box>
    </Modal>
  );
}

/**
 * A dialog's buttons, right-aligned, after `hint`: a quiet line on what pressing them will do.
 *
 * As the last child of a `Dialog` it is a bar across the dialog's foot that stays in view while the
 * body scrolls under it, over a grey hat field that fades out upward; on a phone the buttons share
 * its width. With only a hint it is the dialog's foot all the same (About's facts).
 * Anywhere else — a panel that is also a dialog's body — it is a plain row.
 */
export function DialogActions({ hint, children }: { hint?: ReactNode; children?: ReactNode }) {
  return (
    <Box className='mrx-dialog-actions'>
      <HatField pattern='neutral' kind='foot' />
      {hint && <Box className='mrx-dialog-hint'>{hint}</Box>}
      {children}
    </Box>
  );
}
