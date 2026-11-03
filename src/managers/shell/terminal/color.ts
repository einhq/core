import { highlightLines, toAnsi } from './syntax.ts';

/** The SGR code of each style a command colors text with. */
const SGR = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 };

type ColorName = keyof typeof SGR;

/** `str` in `color`, followed by a full reset. */
export const color = (color: ColorName, str: string): string => `\x1b[${SGR[color]}m${str}\x1b[0m`;

export const colorer = (disabled?: boolean) => {
  return (name: ColorName, str: string): string => {
    return disabled ? str : color(name, str);
  };
};

/** A function that colors text in a language; with `disabled` (no terminal) it returns the text as is. */
export const highlighter = (disabled?: boolean) => {
  return (str: string, lang: string): string => {
    return disabled ? str : toAnsi(highlightLines(str, lang));
  };
};
