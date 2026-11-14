import { Box } from '@mantine/core';
import type { CSSProperties } from 'react';
import { hashString } from '../../lib/hash-string.ts';
import { MARK_COLORS } from '../Layout/EinMark.tsx';
import { HatIdenticon } from './HatIdenticon.tsx';

/** A module's colour: one of the mark's, by its name, so a module has the same one wherever it is drawn. */
export const moduleColor = (name: string): string => MARK_COLORS[hashString(`module:${name}`) % MARK_COLORS.length];

/** A module's picture: a hat identicon of its name, with its initials, in its colour on a tint of it. */
export function ModuleAvatar({ name, size }: { name: string; size: number }) {
  const color = moduleColor(name);
  return (
    <Box className='mrx-module-hat' w={size} h={size} style={{ '--mrx-module-color': color } as CSSProperties}>
      <HatIdenticon seed={`module:${name}`} label={name} color={color} />
    </Box>
  );
}
