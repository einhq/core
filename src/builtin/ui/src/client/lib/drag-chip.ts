const CHIP_ICON = 18;

/**
 * Drag a small chip rather than what was pressed.
 *
 * Without a drag image the browser draws the dragged element itself: a details row as wide as all
 * its columns, or a picture at full size, trailing across the page. The chip is the source's own
 * icon or thumbnail, a label (a name, "3 groups · 412 photos") and how many more come along, in a
 * box that exists only for the moment the browser takes its picture.
 */
export function setDragChip(event: { dataTransfer: DataTransfer | null }, source: HTMLElement | null, label: string, more = 0): void {
  if (!event.dataTransfer) return;
  const chip = document.createElement('div');
  Object.assign(chip.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '280px',
    padding: '4px 10px 4px 5px',
    borderRadius: '6px',
    border: '1px solid var(--mrx-hairline)',
    background: 'var(--mrx-surface-overlay)',
    color: 'var(--mrx-text-primary)',
    font: '13px var(--mantine-font-family-monospace)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  });

  // The source's glyph or thumbnail, shrunk to fit the chip.
  const icon = source?.querySelector<HTMLElement>('img, .mantine-ThemeIcon-root')?.cloneNode(true) as HTMLElement | undefined;
  if (icon) {
    Object.assign(icon.style, { width: `${CHIP_ICON}px`, height: `${CHIP_ICON}px`, minWidth: `${CHIP_ICON}px`, minHeight: `${CHIP_ICON}px`, flexShrink: '0', opacity: '1' });
    icon.querySelector('svg')?.setAttribute('width', '12');
    icon.querySelector('svg')?.setAttribute('height', '12');
    chip.append(icon);
  }

  const name = document.createElement('span');
  Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' });
  name.textContent = label || '/';
  chip.append(name);

  if (more > 0) {
    const rest = document.createElement('span');
    Object.assign(rest.style, { flexShrink: '0', color: 'var(--mrx-text-secondary)' });
    rest.textContent = `+${more}`;
    chip.append(rest);
  }

  document.body.append(chip);
  event.dataTransfer.setDragImage(chip, 12, 14);
  // The browser has its picture once this handler returns.
  setTimeout(() => chip.remove(), 0);
}
