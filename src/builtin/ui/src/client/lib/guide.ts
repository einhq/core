import { DOCS_GUIDE_PATH } from '@ein/paths';

/**
 * The guide is einhq.eu's documentation, bundled: the site's tree mounted at `DOCS_GUIDE_PATH`, its
 * pages under `docs/` and the screenshots and fonts they use under `assets/`. A page is named by its
 * path under `docs/` (`shell/ssh-sftp.md`), as the site's own links name it.
 */
export const GUIDE_ROOT = `${DOCS_GUIDE_PATH}/docs`;

/** Where the guide is published, for an installation that has no bundle. */
export const GUIDE_SITE = 'https://einhq.eu/docs/';

export type GuidePage = { title: string; path: string; depth: number };
type GuideSection = { title: string; part: string; pages: GuidePage[] };
/**
 * The guide's contents in the order of its sidebar: `sections` as shown, `pages` all of them in
 * order, and `modules` the folders of the modules' sections (`archive`).
 */
export type Guide = { sections: GuideSection[]; pages: GuidePage[]; modules: string[] };

/** A guide path resolved against the directory of the page it is written in; null when it climbs out of the guide. */
export function resolveGuidePath(dir: string, rel: string): string | null {
  const stack = dir.split('/').filter(Boolean);
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(segment);
  }
  return stack.join('/');
}

/** The directory a guide page is in: '' for the top. */
export const guideDir = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** The route of a guide page: `index.md` is `/docs`, `archive/index.md` is `/docs/archive`, `shell/ssh-sftp.md` is `/docs/shell/ssh-sftp`. */
export function guideRoute(path: string, hash = ''): string {
  const name = path.replace(/\.md$/i, '').replace(/(^|\/)index$/, '');
  return `/docs${name ? `/${name}` : ''}${hash ? `#${hash}` : ''}`;
}

/** The guide page a route under `/docs/` names, as `guideRoute` makes it: a page of that name, or else the index of that folder. */
export function guidePageOf(guide: Guide, route: string): string {
  if (!route) return 'index.md';
  return guide.pages.some((page) => page.path === `${route}.md`) ? `${route}.md` : `${route}/index.md`;
}

/** The sections of the site's environment page, by the kind of variable the live page groups the same ones under. */
const ENV_SECTIONS: Record<string, string> = {
  'set-by-the-deployment': 'deployment',
  'folders-in-the-tree': 'path',
  'set-by-the-system': 'system',
  'set-for-each-shell': 'session',
  'options-you-set': 'option',
  'set-for-a-pipeline-step': 'pipeline',
};

/**
 * The site's pages that a running EiN generates itself, from what is installed here: a link to one
 * goes to the live page, at the same entry where it has one. They are the reference pages, and a
 * module's `commands.md` in its section (`modules`, the guide's). Undefined for any other page.
 */
export function liveRoute(path: string, hash = '', modules: string[] = []): string | undefined {
  const module = path.match(/^([\w-]+)\/commands\.md$/)?.[1];
  if (module && modules.includes(module)) return hash ? `/docs/commands#cmd-${hash}` : `/docs/modules/${encodeURIComponent(module)}#commands`;
  const page = path.match(/^reference\/([\w-]+)\.md$/)?.[1];
  if (!page) return undefined;
  if (page === 'commands' || page.startsWith('commands-')) return `/docs/commands${hash ? `#cmd-${hash}` : ''}`;
  if (page === 'settings') return `/docs/settings${hash ? `#set-${hash.toUpperCase()}` : ''}`;
  if (page === 'environment') return `/docs/environment${ENV_SECTIONS[hash] ? `#env-${ENV_SECTIONS[hash]}` : ''}`;
  if (page === 'node-types') {
    if (!hash) return '/docs/node-types';
    return ['content', 'structure', 'system'].includes(hash) ? `/docs/node-types#types-${hash}` : `/docs/node-types#type-${hash}`;
  }
  return undefined;
}

/**
 * The site's `docs/SUMMARY.md`, in mdBook's form: a link before any heading is a page outside the
 * sections (the welcome page), each `#` heading a part that groups the sections after it (Core,
 * then the modules), each `##` heading a section, and each list item under it a page, indented two
 * spaces for a page under the one above. A section in a part after the first is a module's, its
 * pages in the module's folder. The pages this installation draws live (`liveRoute`) are left out.
 */
export function parseSummary(text: string): Guide {
  const sections: GuideSection[] = [{ title: '', part: '', pages: [] }];
  let part = '';
  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    if (heading?.[1] === '#') {
      // The file's own title, "# Contents", comes before any section and names no part.
      if (sections.length > 1 || sections[0].pages.length) part = heading[2].trim();
      continue;
    }
    if (heading) {
      sections.push({ title: heading[2].trim(), part, pages: [] });
      continue;
    }
    const item = line.match(/^(\s*)(?:[-*]\s+)?\[([^\]]+)\]\(([^)]+\.md)\)\s*$/);
    const path = item && resolveGuidePath('', item[3]);
    if (!item || !path) continue;
    sections.at(-1)!.pages.push({ title: item[2], path, depth: Math.floor(item[1].length / 2) });
  }
  const parts = [...new Set(sections.map((section) => section.part).filter(Boolean))];
  const modules = [
    ...new Set(sections.filter((section) => section.part && section.part !== parts[0]).flatMap((section) => section.pages.map((page) => guideDir(page.path).split('/')[0]))),
  ].filter(Boolean);
  const shown = sections
    .map((section) => ({ ...section, pages: section.pages.filter((page) => !liveRoute(page.path, '', modules)) }))
    .filter((section) => section.pages.length);
  return { sections: shown, pages: shown.flatMap((section) => section.pages), modules };
}

/** The pages of a module's section of the guide: those under the folder named after it, its overview first. */
export const modulePages = (guide: Guide | null | undefined, name: string): GuidePage[] => (guide?.pages ?? []).filter((page) => page.path.startsWith(`${name}/`));
