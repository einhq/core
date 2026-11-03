/**
 * The third-party notices the image ships: every package `deno.lock` pins and the self-hosted
 * fonts, each with its licence and the licence text, written as one plain-text file that the bundle
 * serves at `/public/licences.txt` and the About page links to.
 *
 * - npm packages: `license` from their `package.json` and their LICENSE/LICENCE/COPYING/NOTICE
 *   files, out of Deno's npm cache or, failing that, the node_modules directory the bundler
 *   materialises;
 * - jsr packages and deno.land/x modules: the LICENSE file at the root of the published version,
 *   fetched, as Deno keeps neither under a name that can be read back (for an `@std` package that
 *   publishes none, the std repository's);
 * - fonts: the licence files beside them in `public/fonts/`.
 *
 * A notice that cannot be found is written as missing, so the list stays complete and the gap shows.
 */
import { exists } from '@std/fs';
import { join } from '@std/path';

const NOTICE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The fonts in `public/fonts/`, with the files that hold their licence. */
const FONTS = [
  { name: 'Inter', licence: 'OFL-1.1', source: 'https://github.com/rsms/inter', files: ['OFL-inter.txt'] },
  { name: 'Mochiy Pop One', licence: 'OFL-1.1', source: 'https://github.com/fontdasu/Mochiypop', files: ['OFL-mochiy-pop-one.txt'] },
  { name: 'Special Elite', licence: 'Apache-2.0', source: 'https://fonts.google.com/specimen/Special+Elite', files: ['LICENSE-special-elite.txt'] },
];

type Entry = { name: string; licence: string; source: string; texts: string[] };

/** `@scope/name@1.2.3` (or `name@1.2.3_peer@4`) as name and version. */
const split = (key: string) => {
  const at = key.indexOf('@', 1);
  return { name: key.slice(0, at), version: key.slice(at + 1).split('_')[0] };
};

const noticesIn = async (dir: string) => {
  const texts: string[] = [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) if (entry.isFile && NOTICE.test(entry.name)) names.push(entry.name);
  for (const name of names.sort()) texts.push((await Deno.readTextFile(join(dir, name))).trim());
  return texts;
};

const npmLicence = (pkg: Record<string, unknown>) => {
  const licence = pkg.license ?? pkg.licenses;
  if (typeof licence === 'string') return licence;
  if (Array.isArray(licence)) return licence.map((l) => (typeof l === 'string' ? l : l?.type)).join(' OR ');
  if (licence && typeof licence === 'object' && 'type' in licence) return String(licence.type);
  return 'unknown';
};

async function npmEntry(key: string, npmCache: string, repoDir: string): Promise<Entry> {
  const { name, version } = split(key);
  const dirs = [
    join(npmCache, 'registry.npmjs.org', name, version),
    join(repoDir, 'node_modules', '.deno', `${name.replace('/', '+')}@${version}`, 'node_modules', name),
  ];
  for (const dir of dirs) {
    if (!(await exists(join(dir, 'package.json')))) continue;
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, 'package.json')));
    return { name: `${name} ${version}`, licence: npmLicence(pkg), source: `https://www.npmjs.com/package/${name}/v/${version}`, texts: await noticesIn(dir) };
  }
  return { name: `${name} ${version}`, licence: 'unknown', source: `https://www.npmjs.com/package/${name}/v/${version}`, texts: [] };
}

/** The first of `urls` that answers, as text. */
async function fetchFirst(urls: string[]) {
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) return (await response.text()).trim();
      await response.body?.cancel();
    } catch {
      // offline or refused: try the next, and report it missing after the last
    }
  }
  return undefined;
}

const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'];

/** Where a package that publishes no LICENSE of its own has it: the repository of its scope. */
const SCOPE_LICENCE: Record<string, string> = { '@std': 'https://raw.githubusercontent.com/denoland/std/main/LICENSE' };

async function remoteEntry(name: string, source: string, base: string, fallback?: string): Promise<Entry> {
  const text = await fetchFirst([...LICENCE_FILES.map((file) => `${base}/${file}`), ...(fallback ? [fallback] : [])]);
  return { name, licence: text ? licenceOf(text) : 'unknown', source, texts: text ? [text] : [] };
}

/** The licence a LICENSE file's text names, for the files whose package says nothing else. */
const licenceOf = (text: string) => {
  if (/Permission is hereby granted, free of charge/.test(text)) return 'MIT';
  if (/Apache License\s+Version 2\.0/.test(text)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/.test(text)) return /Neither the name/.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Permission to use, copy, modify, and\/or distribute/.test(text)) return 'ISC or 0BSD';
  return 'see the text';
};

/** Write the notices for `repoDir`'s `deno.lock` and `fontsDir`'s fonts to `out`; returns the packages it found no licence text for. */
export async function writeLicences(repoDir: string, fontsDir: string, out: string) {
  const lock = JSON.parse(await Deno.readTextFile(join(repoDir, 'deno.lock')));
  const info = new Deno.Command(Deno.execPath(), { args: ['info', '--json'], stdout: 'piped', stderr: 'null' }).outputSync();
  const npmCache: string = JSON.parse(new TextDecoder().decode(info.stdout)).npmCache;

  const npm = await Promise.all(Object.keys(lock.npm ?? {}).map((key) => npmEntry(key, npmCache, repoDir)));
  const jsr = await Promise.all(
    Object.keys(lock.jsr ?? {}).map((key) => {
      const { name, version } = split(key);
      return remoteEntry(`${name} ${version}`, `https://jsr.io/${name}@${version}`, `https://jsr.io/${name}/${version}`, SCOPE_LICENCE[name.split('/')[0]]);
    }),
  );
  const modules = [...new Set(Object.keys(lock.remote ?? {}).map((url) => url.match(/^https:\/\/deno\.land\/(?:x\/)?[^/]+@[^/]+/)?.[0]).filter((m) => m !== undefined))];
  const remote = await Promise.all(modules.map((base) => remoteEntry(base.replace('https://deno.land/', ''), base, base)));
  const fonts = await Promise.all(FONTS.map(async (font) => ({
    name: font.name,
    licence: font.licence,
    source: font.source,
    texts: await Promise.all(font.files.map(async (file) => (await Deno.readTextFile(join(fontsDir, file))).trim())),
  })));

  const sections: [string, Entry[]][] = [['npm packages', npm], ['jsr packages', jsr], ['deno.land modules', remote], ['Fonts', fonts]];
  const rule = '='.repeat(78);
  let text = [
    'EiN: third-party notices',
    '',
    "EiN's own code is under the Elastic License 2.0, with a permission added (https://github.com/einhq/core/blob/main/LICENSE).",
    'It is built from, and its Web UI carries, the third-party code and fonts below, each under its',
    'own licence, whose text follows its entry.',
    '',
  ].join('\n');
  for (const [title, entries] of sections) {
    text += `\n${rule}\n${title} (${entries.length})\n${rule}\n`;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      text += `\n--- ${entry.name}\nLicence: ${entry.licence}\nSource: ${entry.source}\n`;
      text += entry.texts.length ? `\n${entry.texts.join('\n\n')}\n` : '\n(no licence text was found in the package)\n';
    }
  }
  await Deno.writeTextFile(out, text);
  return [...npm, ...jsr, ...remote].filter((entry) => entry.texts.length === 0).map((entry) => entry.name);
}
