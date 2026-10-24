import { stripAnsiCode } from '@std/fmt/colors';

type TableColumn = {
  name: string;
  align?: 'left' | 'right';
};

type TableOptions = {
  columns: TableColumn[];
  header?: boolean;
};

const pad = (str: string, width: number, align: 'left' | 'right' = 'left') => {
  const diff = width - stripAnsiCode(str).length;
  const padStr = ' '.repeat(Math.max(0, diff));

  return align === 'right' ? padStr + str : str + padStr;
};

export class Table {
  opts: TableOptions;
  rows: Record<string, string>[] = [];

  constructor(opts: TableOptions) {
    this.opts = opts;
  }

  addRow(row: Record<string, string>) {
    this.rows.push(row);
  }

  render() {
    const lines = [];
    const columns = this.opts.columns.map((def) => def.name);
    const widths = columns.map((col) => this.opts.header ? col.length : 0);

    for (const row of this.rows) {
      for (const [i, col] of columns.entries()) {
        widths[i] = Math.max(widths[i], stripAnsiCode(row[col]).length);
      }
    }

    if (this.opts.header) {
      const header = columns.map((col, i) => pad(col, widths[i], this.opts.columns.find((def) => def.name === col)?.align));

      lines.push(header.join(' ').trimEnd());
    }

    for (const row of this.rows) {
      const line = columns.map((col, i) => pad(row[col], widths[i], this.opts.columns.find((def) => def.name === col)?.align));

      // The last column is padded to its widest cell like the rest; nothing follows it to line up.
      lines.push(line.join(' ').trimEnd());
    }

    return `${lines.join('\n')}\n`;
  }
}
