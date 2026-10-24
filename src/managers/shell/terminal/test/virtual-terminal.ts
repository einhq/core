/**
 * A terminal small enough for tests: it applies what a full-screen command writes — cursor
 * moves, clears, text — to a grid of characters, and keeps each cell's colors apart. Wide
 * characters take their cell and a blank.
 */

import { codePointWidth } from '../width.ts';

export class VirtualTerminal {
  grid: string[][];
  row = 0;
  col = 0;
  /** The SGR parameters in effect at each cell, for tests about color. */
  styles: string[][];
  private style = '';

  constructor(public rows: number, public cols: number) {
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
    this.styles = Array.from({ length: rows }, () => new Array(cols).fill(''));
  }

  write(data: string) {
    for (let i = 0; i < data.length;) {
      if (data[i] === '\x1b' && data[i + 1] === '[') {
        let j = i + 2;
        while (j < data.length && /[0-9;?]/.test(data[j])) j++;
        const params = data.slice(i + 2, j);
        const final = data[j];
        if (final === 'H') {
          const [r, c] = params.split(';').map((n) => Number(n || '1'));
          this.row = (r || 1) - 1;
          this.col = (c || 1) - 1;
        } else if (final === 'K') {
          for (let c = this.col; c < this.cols; c++) this.grid[this.row][c] = ' ';
        } else if (final === 'J' && params === '2') {
          this.grid = Array.from({ length: this.rows }, () => new Array(this.cols).fill(' '));
        } else if (final === 'm') {
          this.style = params.replace(/^0;?/, '');
        }
        i = j + 1;
        continue;
      }
      const char = String.fromCodePoint(data.codePointAt(i)!);
      i += char.length;
      const width = codePointWidth(char.codePointAt(0)!);
      if (this.col < this.cols && this.row < this.rows) {
        this.grid[this.row][this.col] = char;
        this.styles[this.row][this.col] = this.style;
        if (width === 2 && this.col + 1 < this.cols) this.grid[this.row][this.col + 1] = '';
      }
      this.col += width;
    }
  }

  /** Row `n` as text, trailing blanks dropped. */
  line(n: number): string {
    return this.grid[n].join('').trimEnd();
  }

  get text(): string {
    return this.grid.map((_, n) => this.line(n)).join('\n');
  }
}
