/**
 * Mode bits as text, the way the shell prints them: the nine permission bits, and the sticky bit
 * (`/tmp`'s) in the others' execute position. EiN keeps nothing in the setuid and setgid positions.
 */

const STICKY = 0o1000;

const CLASSES = [6, 3, 0] as const;

const triple = (mode: number, shift: number): string => {
  const bits = (mode >> shift) & 0o7;
  return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
};

/** `0o750` → `rwxr-x---`, `0o1777` → `rwxrwxrwt`. */
export function modeString(mode: number): string {
  const text = CLASSES.map((shift) => triple(mode, shift)).join('');
  return mode & STICKY ? text.slice(0, 8) + (text[8] === 'x' ? 't' : 'T') : text;
}

/** `0o750` → `0750`, always four digits so a column of them lines up. */
export function modeOctal(mode: number): string {
  return (mode & (0o777 | STICKY)).toString(8).padStart(4, '0');
}

/** `'750'`, `'0750'` or `'1777'` → the mode; `undefined` when it is not an octal mode EiN keeps. */
export function parseOctal(text: string): number | undefined {
  if (!/^[01]?[0-7]{3}$/.test(text)) return undefined;
  return parseInt(text, 8);
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
