/**
 * Mode bits as text, the way the shell prints them. Only the nine permission
 * bits are shown; EiN keeps nothing in the setuid/sticky positions.
 */

const CLASSES = [6, 3, 0] as const;

const triple = (mode: number, shift: number): string => {
  const bits = (mode >> shift) & 0o7;
  return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
};

/** `0o750` → `rwxr-x---`. */
export function modeString(mode: number): string {
  return CLASSES.map((shift) => triple(mode, shift)).join('');
}

/** `0o750` → `0750`, always four digits so a column of them lines up. */
export function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/** `'750'` or `'0750'` → `0o750`; `undefined` when it is not an octal mode. */
export function parseOctal(text: string): number | undefined {
  if (!/^[0-7]{3,4}$/.test(text)) return undefined;
  return parseInt(text, 8) & 0o777;
}

export type ModeClass = 'owner' | 'group' | 'other';
export type ModeBit = 'r' | 'w' | 'x';

const SHIFT: Record<ModeClass, number> = { owner: 6, group: 3, other: 0 };
const BIT: Record<ModeBit, number> = { r: 4, w: 2, x: 1 };

export function hasBit(mode: number, cls: ModeClass, bit: ModeBit): boolean {
  return ((mode >> SHIFT[cls]) & BIT[bit]) !== 0;
}

export function withBit(mode: number, cls: ModeClass, bit: ModeBit, on: boolean): number {
  const mask = BIT[bit] << SHIFT[cls];
  return on ? mode | mask : mode & ~mask;
}
