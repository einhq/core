/**
 * Writes the zips `unzip.test.ts` expands, with invented content:
 *
 * - `nested.zip`: a directory tree, one entry deflated and the rest stored, an empty directory
 *   entry, and a file at the top whose name is not ASCII. Every entry is dated 2019-07-14 10:30 UTC.
 * - `slip.zip`: a harmless entry, and one named `../utanfor.txt` that would land outside the
 *   directory it is expanded into.
 *
 * Run from the repository root: `deno run -A src/managers/exec/commands/test/fixtures/unzip/make.ts`.
 */

import { configure, TextReader, Uint8ArrayWriter, ZipWriter } from '@zip-js/zip-js';

configure({ useWebWorkers: false });

const DATE = new Date('2019-07-14T10:30:00Z');

type Item = { name: string; text?: string; deflate?: boolean };

const write = async (file: string, items: Item[]) => {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { lastModDate: DATE });
  for (const item of items) {
    if (item.text === undefined) {
      await zip.add(item.name, undefined, { directory: true });
    } else {
      await zip.add(item.name, new TextReader(item.text), { level: item.deflate ? 9 : 0 });
    }
  }
  await Deno.writeFile(new URL(file, import.meta.url), await zip.close());
};

await write('nested.zip', [
  { name: 'Exempelresa/' },
  { name: 'Exempelresa/dag-1/anteckningar.txt', text: 'En segelbåt vid bryggan, och en till bakom den.\n'.repeat(8), deflate: true },
  { name: 'Exempelresa/dag-1/karta/rutt.txt', text: 'Från udden till ön.\n' },
  { name: 'Exempelresa/dag-2/tom/' },
  { name: 'Exempelresa/dag-2/väder.txt', text: 'Sol hela dagen.\n' },
  { name: 'lösa-blad.txt', text: 'Anna Andersson var med.\n' },
]);

await write('slip.zip', [
  { name: 'inne.txt', text: 'Stannar där den ska.\n' },
  { name: '../utanfor.txt', text: 'Ska aldrig skrivas.\n' },
]);
