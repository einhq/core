export const columns = (items: string[], width: number): string => {
  const longestItemLength = Math.max(...items.map((item) => item.length));

  const columnWidth = longestItemLength + 2;

  const numColumns = Math.max(1, Math.floor(width / columnWidth));

  const numRows = Math.ceil(items.length / numColumns);

  const columns: string[][] = Array.from({ length: numColumns }, () => []);

  for (let i = 0; i < items.length; i++) {
    const columnIndex = Math.floor(i / numRows);
    columns[columnIndex].push(items[i]);
  }

  const columnWidths = columns.map((col) => Math.max(...col.map((item) => item.length)) + 2);

  let result = '';
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numColumns; col++) {
      if (columns[col][row] !== undefined) {
        const item = columns[col][row];
        result += item.padEnd(columnWidths[col], ' ');
      }
    }
    result = result.trimEnd();
    result += '\n';
  }

  return result.trimEnd();
};
