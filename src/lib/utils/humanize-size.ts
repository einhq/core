/**
 * Converts a size in bytes to a human-readable format.
 *
 * Bytes stay whole (`512 B`, not `512.00 B`) and larger units keep one decimal
 * (`1.5 KB`), which is what reads well in a column of sizes.
 *
 * @param bytes - The size in bytes.
 * @returns A string representing the human-readable size.
 */
export const humanizeSize = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;

  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }

  return `${bytes.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};
