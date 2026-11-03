/**
 * Third-party notices: each package and font with its licence and the licence text, as one
 * plain-text file. There are two:
 *
 * - the image's, `public/licences.txt` in the shell (`writeLicences`, run by the UI bundle): the
 *   self-hosted fonts and every package core's own dependencies reach in `deno.lock`;
 * - an installation's, `/var/cache/ui/licences.txt` (`installationLicences`, run by
 *   `ui-build`): the image's, followed by the packages the installed modules' `mod.json` imports
 *   reach and core's do not. They are resolved by `deno info` against core's configuration and
 *   lock, as the modules' code is when it runs, so a package core also uses is core's version.
 *
 * Where the texts come from:
 *
 * - npm packages: `license` from their `package.json` and their LICENSE/LICENCE/COPYING/NOTICE
 *   files, out of Deno's npm cache or, failing that, the node_modules directory the bundler
 *   materialises; for a package that ships none, its README's licence section, or else the
 *   LICENSE of its GitHub repository (`npmTexts`);
 * - jsr packages: the LICENSE file at the root of the published version, fetched, as Deno keeps
 *   none under a name that can be read back (for an `@std` package that publishes none, the std
 *   repository's);
 * - fonts: the licence files beside them in `public/fonts/`.
 *
 * A notice that cannot be found is written as missing, so the list stays complete and the gap shows.
 */
import { exists } from '@std/fs';
import { fromFileUrl, join } from '@std/path';

/** Core's checkout, whose `deno.jsonc` and `deno.lock` the running EiN resolves packages by. */
const CORE_DIR = fromFileUrl(new URL('../../../../', import.meta.url));

const NOTICE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The fonts in `public/fonts/`, with the files that hold their licence. */
const FONTS = [
  { name: 'Inter', licence: 'OFL-1.1', source: 'https://github.com/rsms/inter', files: ['OFL-inter.txt'] },
  { name: 'Mochiy Pop One', licence: 'OFL-1.1', source: 'https://github.com/fontdasu/Mochiypop', files: ['OFL-mochiy-pop-one.txt'] },
  { name: 'Special Elite', licence: 'Apache-2.0', source: 'https://fonts.google.com/specimen/Special+Elite', files: ['LICENSE-special-elite.txt'] },
];

type Entry = { name: string; licence: string; source: string; texts: string[]; usedBy?: string[] };

/** A package at the version resolved: `npm:react@19.2.3`, `jsr:@std/path@1.1.6`. */
type Package = { kind: 'npm' | 'jsr'; name: string; version: string };

const keyOf = (pkg: Package) => `${pkg.kind}:${pkg.name}@${pkg.version}`;

/** `@scope/name@1.2.3` (or `name@1.2.3_peer@4`) as name and version. */
const split = (key: string) => {
  const at = key.indexOf('@', 1);
  return { name: key.slice(0, at), version: key.slice(at + 1).split('_')[0] };
};

type Lock = {
  specifiers?: Record<string, string>;
  jsr?: Record<string, { dependencies?: string[] }>;
  npm?: Record<string, { dependencies?: string[]; optionalDependencies?: string[]; optionalPeers?: string[] }>;
  workspace?: { dependencies?: string[] };
  remote?: Record<string, string>;
};

/**
 * The packages core's own dependencies (the lock's `workspace.dependencies`) reach, through the
 * lock's record of each package's. A workspace member's (a module checked out beside core) are
 * left out unless core's reach them too.
 */
const corePackages = (lock: Lock): Package[] => {
  const jsr = Object.keys(lock.jsr ?? {});
  const npm = Object.keys(lock.npm ?? {});
  const named = (keys: string[], name: string) => keys.filter((key) => split(key).name === name);
  const found = new Map<string, { kind: 'npm' | 'jsr'; key: string }>();

  /** A `jsr:`/`npm:` specifier to the lock key it resolved to; a bare name is the only version locked. */
  const resolve = (specifier: string) => {
    const kind = specifier.startsWith('jsr:') ? 'jsr' : 'npm';
    const rest = specifier.slice(4);
    const at = rest.indexOf('@', 1);
    const name = at < 0 ? rest : rest.slice(0, at);
    const version = lock.specifiers?.[specifier];
    const keys = version ? [`${name}@${version}`] : named(kind === 'jsr' ? jsr : npm, name);
    if (keys.length !== 1) throw new Error(`deno.lock: cannot tell which ${specifier} is locked`);
    return { kind, key: keys[0] } as const;
  };
  /** An npm package's dependency: a lock key, or a name locked at one version. */
  const npmDependency = (dependency: string) => {
    if (lock.npm?.[dependency]) return dependency;
    const keys = named(npm, dependency);
    if (keys.length !== 1) throw new Error(`deno.lock: cannot tell which npm ${dependency} is locked`);
    return keys[0];
  };

  const queue = (lock.workspace?.dependencies ?? []).map(resolve);
  while (queue.length) {
    const { kind, key } = queue.pop()!;
    if (found.has(`${kind}:${key}`)) continue;
    found.set(`${kind}:${key}`, { kind, key });
    if (kind === 'jsr') {
      queue.push(...(lock.jsr?.[key]?.dependencies ?? []).map(resolve));
    } else {
      const entry = lock.npm?.[key] ?? {};
      const dependencies = [...entry.dependencies ?? [], ...entry.optionalDependencies ?? [], ...entry.optionalPeers ?? []];
      queue.push(...dependencies.map((dependency) => ({ kind: 'npm' as const, key: npmDependency(dependency) })));
    }
  }
  return [...found.values()].map(({ kind, key }) => ({ kind, ...split(key) }));
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

/** Words a licence's own text has, as against a section that only names one ("MIT"). */
const LICENCE_TEXT = /Permission is hereby granted|Redistribution and use in source and binary forms|Permission to use, copy, modify|Apache License/;

/** The licence section of a package's README, when it holds the licence's text: its heading to the next of the same level. */
const readmeLicence = async (dir: string): Promise<string | undefined> => {
  let readme: string;
  try {
    readme = await Deno.readTextFile(join(dir, 'README.md'));
  } catch {
    return undefined;
  }
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s*licen[cs]e\b/i.test(line));
  if (start < 0) return undefined;
  const level = lines[start].match(/^#+/)![0].length;
  const end = lines.findIndex((line, i) => i > start && /^#+\s/.test(line) && line.match(/^#+/)![0].length <= level);
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return LICENCE_TEXT.test(section) ? section : undefined;
};

/** The GitHub repository a `package.json` names, as `owner/name`. */
const githubRepository = (pkg: Record<string, unknown>): string | undefined => {
  const repository = pkg.repository;
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string') return undefined;
  const shorthand = url.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
  const full = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#]|$)/);
  const [, owner, name] = shorthand ?? full ?? [];
  return owner && name ? `${owner}/${name}` : undefined;
};

/**
 * The texts of an npm package's licence and notices: the files it ships, or, for one that ships
 * none, the licence section of its README, or else the LICENSE of the GitHub repository it names,
 * as that repository holds it now. A borrowed text says where it is from.
 */
async function npmTexts(dir: string, pkg: Record<string, unknown>): Promise<string[]> {
  const shipped = await noticesIn(dir);
  if (shipped.length) return shipped;
  const readme = await readmeLicence(dir);
  if (readme) return [`(The package ships no licence file; this is the licence section of its README.)\n\n${readme}`];
  const repository = githubRepository(pkg);
  if (!repository) return [];
  for (const file of [...LICENCE_FILES, 'license', 'license.md']) {
    const url = `https://raw.githubusercontent.com/${repository}/HEAD/${file}`;
    const text = await fetchFirst([url]);
    if (text) return [`(The package ships no licence file; this is the one in its repository, https://github.com/${repository}/blob/HEAD/${file}.)\n\n${text}`];
  }
  return [];
}

/** An npm package's entry, from the first of `dirs` that holds it. */
async function npmEntry({ name, version }: Package, dirs: string[]): Promise<Entry> {
  const source = `https://www.npmjs.com/package/${name}/v/${version}`;
  for (const dir of dirs) {
    if (!(await exists(join(dir, 'package.json')))) continue;
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, 'package.json')));
    return { name: `${name} ${version}`, licence: npmLicence(pkg), source, texts: await npmTexts(dir, pkg) };
  }
  return { name: `${name} ${version}`, licence: 'unknown', source, texts: [] };
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

async function jsrEntry({ name, version }: Package): Promise<Entry> {
  const base = `https://jsr.io/${name}/${version}`;
  const fallback = SCOPE_LICENCE[name.split('/')[0]];
  const text = await fetchFirst([...LICENCE_FILES.map((file) => `${base}/${file}`), ...(fallback ? [fallback] : [])]);
  return { name: `${name} ${version}`, licence: text ? licenceOf(text) : 'unknown', source: `https://jsr.io/${name}@${version}`, texts: text ? [text] : [] };
}

/** The licence a LICENSE file's text names, for the files whose package says nothing else. */
const licenceOf = (text: string) => {
  if (/Permission is hereby granted, free of charge/.test(text)) return 'MIT';
  if (/Apache License\s+Version 2\.0/.test(text)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/.test(text)) return /Neither the name/.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Permission to use, copy, modify, and\/or distribute/.test(text)) return 'ISC or 0BSD';
  return 'see the text';
};

const RULE = '='.repeat(78);

const section = (title: string, entries: Entry[]) => {
  let text = `\n${RULE}\n${title} (${entries.length})\n${RULE}\n`;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    text += `\n--- ${entry.name}\nLicence: ${entry.licence}\nSource: ${entry.source}\n`;
    if (entry.usedBy) text += `Used by: ${entry.usedBy.join(', ')}\n`;
    text += entry.texts.length ? `\n${entry.texts.join('\n\n')}\n` : '\n(no licence text was found in the package)\n';
  }
  return text;
};

const missing = (entries: Entry[]) => entries.filter((entry) => entry.texts.length === 0).map((entry) => entry.name);

const readLock = async (repoDir: string): Promise<Lock> => JSON.parse(await Deno.readTextFile(join(repoDir, 'deno.lock')));

/** Write the image's notices, for `repoDir`'s `deno.lock` and `fontsDir`'s fonts, to `out`; returns the packages it found no licence text for. */
export async function writeLicences(repoDir: string, fontsDir: string, out: string) {
  const lock = await readLock(repoDir);
  // A URL import would be in no section below, and its notice silently left out.
  if (Object.keys(lock.remote ?? {}).length) throw new Error('deno.lock pins remote modules, which the third-party notices do not cover');
  const info = new Deno.Command(Deno.execPath(), { args: ['info', '--json'], stdout: 'piped', stderr: 'null' }).outputSync();
  const npmCache: string = JSON.parse(new TextDecoder().decode(info.stdout)).npmCache;

  const packages = corePackages(lock);
  const npm = await Promise.all(
    packages.filter((pkg) => pkg.kind === 'npm').map((pkg) =>
      npmEntry(pkg, [
        join(npmCache, 'registry.npmjs.org', pkg.name, pkg.version),
        join(repoDir, 'node_modules', '.deno', `${pkg.name.replace('/', '+')}@${pkg.version}`, 'node_modules', pkg.name),
      ])
    ),
  );
  const jsr = await Promise.all(packages.filter((pkg) => pkg.kind === 'jsr').map(jsrEntry));
  const fonts = await Promise.all(FONTS.map(async (font) => ({
    name: font.name,
    licence: font.licence,
    source: font.source,
    texts: await Promise.all(font.files.map(async (file) => (await Deno.readTextFile(join(fontsDir, file))).trim())),
  })));

  const text = [
    'EiN: third-party notices',
    '',
    "EiN's own code is under the Elastic License 2.0, with a permission added (https://github.com/einhq/core/blob/main/LICENSE).",
    'It is built from, and its Web UI carries, the third-party code and fonts below, each under its',
    'own licence, whose text follows its entry.',
    '',
  ].join('\n') + section('npm packages', npm) + section('jsr packages', jsr) + section('Fonts', fonts);
  await Deno.writeTextFile(out, text);
  return missing([...npm, ...jsr]);
}

/** What `deno info --json` says of a graph: the npm packages it knows, and each module's. */
type DenoInfo = {
  modules: { specifier: string; kind?: string; npmPackage?: string }[];
  npmPackages: Record<string, { name: string; version: string; dependencies: string[]; localPath?: string }>;
};

/**
 * The packages `specifiers` reach, with where each npm one is on disk, resolved as code run
 * against `config` resolves them. Deno fetches what it has not yet.
 */
async function resolvePackages(config: string, specifiers: string[]): Promise<{ pkg: Package; dir?: string }[]> {
  const dir = await Deno.makeTempDir({ prefix: 'ein-licences-' });
  try {
    const probe = join(dir, 'probe.ts');
    await Deno.writeTextFile(probe, specifiers.map((specifier) => `import ${JSON.stringify(specifier)};\n`).join(''));
    const result = await new Deno.Command(Deno.execPath(), { args: ['info', '--json', '--config', config, probe], stdout: 'piped', stderr: 'piped', env: { NO_COLOR: '1' } })
      .output();
    if (!result.success) throw new Error(`deno info failed: ${new TextDecoder().decode(result.stderr).trim()}`);
    const info: DenoInfo = JSON.parse(new TextDecoder().decode(result.stdout));

    const found = new Map<string, { pkg: Package; dir?: string }>();
    // `npmPackages` holds every package the configuration resolves; those the probe reaches are
    // the ones its modules name and theirs.
    const queue = info.modules.flatMap((module) => (module.npmPackage ? [module.npmPackage] : []));
    while (queue.length) {
      const npm = info.npmPackages[queue.pop()!];
      if (!npm) continue;
      const pkg: Package = { kind: 'npm', name: npm.name, version: npm.version };
      if (found.has(keyOf(pkg))) continue;
      found.set(keyOf(pkg), { pkg, dir: npm.localPath });
      queue.push(...npm.dependencies);
    }
    for (const module of info.modules) {
      const jsr = module.specifier.match(/^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\/([^/]+)\//);
      if (jsr) found.set(`jsr:${jsr[1]}@${jsr[2]}`, { pkg: { kind: 'jsr', name: jsr[1], version: jsr[2] } });
    }
    return [...found.values()];
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** A module's name and the `jsr:`/`npm:` targets of its `mod.json` imports. */
export type ModulePackages = { name: string; specifiers: string[] };

/**
 * The installation's notices: `coreText`, the image's, followed by the packages `modules` reach
 * that core's own dependencies do not, each saying which modules use it. Returns the text and the
 * packages it found no licence text for.
 */
export async function installationLicences(coreText: string, modules: ModulePackages[]) {
  const core = new Set(corePackages(await readLock(CORE_DIR)).map(keyOf));
  const own = new Map<string, { pkg: Package; dir?: string; usedBy: string[] }>();
  for (const module of modules) {
    if (!module.specifiers.length) continue;
    for (const { pkg, dir } of await resolvePackages(join(CORE_DIR, 'deno.jsonc'), module.specifiers)) {
      if (core.has(keyOf(pkg))) continue;
      const entry = own.get(keyOf(pkg)) ?? { pkg, dir, usedBy: [] };
      entry.usedBy.push(module.name);
      own.set(keyOf(pkg), entry);
    }
  }
  const entries = await Promise.all(
    [...own.values()].map(async ({ pkg, dir, usedBy }) => ({ ...(pkg.kind === 'npm' ? await npmEntry(pkg, dir ? [dir] : []) : await jsrEntry(pkg)), usedBy })),
  );
  const text = `${coreText.trimEnd()}\n${section("The modules' own packages", entries)}`;
  return { text, missing: missing(entries) };
}
