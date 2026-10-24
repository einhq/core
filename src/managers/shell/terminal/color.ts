import { colorMe } from '@vef/color-me';
import { highlightLines, toAnsi } from './syntax.ts';

export const color = (color: keyof typeof colorMe, str: string): string => {
  return colorMe[color](str);
};

export const colorer = (disabled?: boolean) => {
  return (color: keyof typeof colorMe, str: string): string => {
    return disabled ? str : colorMe[color](str);
  };
};

/** A function that colors text in a language; with `disabled` (no terminal) it returns the text as is. */
export const highlighter = (disabled?: boolean) => {
  return (str: string, lang: string): string => {
    return disabled ? str : toAnsi(highlightLines(str, lang));
  };
};
