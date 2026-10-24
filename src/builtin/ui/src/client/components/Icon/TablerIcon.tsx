import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { fileUrl } from '../../lib/file-url.ts';
import { isTablerName, loadedIcon, loadIcon, type ParsedIcon } from '../../lib/tabler-icons.ts';

/**
 * An icon named by a string, for what is read at runtime — the navigation's
 * configuration, module bundles — rather than imported at build time.
 *
 * - `map-pin` is Tabler's outline icon, `heart-filled` its filled one (the
 *   `IconHeartFilled` of `@tabler/icons-react`), fetched by `lib/tabler-icons.ts` and
 *   drawn inline, so `stroke` and `currentColor` behave as they do for the React
 *   components.
 * - A VFS path (`/usr/modules/x/ui/logo.svg`) is drawn as a CSS mask in the text
 *   colour. It is never inlined: an SVG from the VFS is anyone's markup.
 */
export type TablerIconProps = {
  name: string;
  size?: number | string;
  stroke?: number;
  /** The icon's colour, as `@tabler/icons-react`'s `color`; it follows the text otherwise. */
  color?: string;
  className?: string;
  style?: CSSProperties;
};

export function TablerIcon({ name, size = 20, stroke = 2, color, className, style: given }: TablerIconProps) {
  const style = color ? { color, ...given } : given;
  const isPath = name.startsWith('/');
  const [svg, setSvg] = useState<ParsedIcon | null | undefined>(() => (isPath ? undefined : loadedIcon(name)));

  useEffect(() => {
    if (isPath || !isTablerName(name)) return;
    let live = true;
    setSvg(loadedIcon(name));
    loadIcon(name).then((parsed) => live && setSvg(parsed));
    return () => {
      live = false;
    };
  }, [name, isPath]);

  if (isPath) {
    const mask = `url("${fileUrl(name)}") center / contain no-repeat`;
    return (
      <span
        aria-hidden
        className={className}
        style={{ display: 'inline-block', flex: 'none', width: size, height: size, background: 'currentColor', mask, WebkitMask: mask, ...style }}
      />
    );
  }

  // Before it arrives (and when the name is wrong) an empty box of the same size
  // holds the layout still.
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      aria-hidden
      width={size}
      height={size}
      viewBox={svg?.attrs.viewBox ?? '0 0 24 24'}
      fill={svg?.attrs.fill ?? 'none'}
      stroke={svg?.attrs.stroke}
      strokeWidth={svg?.attrs.stroke ? stroke : undefined}
      strokeLinecap={svg?.attrs['stroke-linecap'] as 'round' | undefined}
      strokeLinejoin={svg?.attrs['stroke-linejoin'] as 'round' | undefined}
      className={className}
      style={{ flex: 'none', ...style }}
      dangerouslySetInnerHTML={svg ? { __html: svg.inner } : undefined}
    />
  );
}
