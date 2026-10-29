import { assertEquals } from '@std/assert';
import { guidePageOf, guideRoute, liveRoute, modulePages, parseSummary, resolveGuidePath } from '../guide.ts';

const SUMMARY = `# Contents

[Welcome](index.md)

# Core

## Using EiN

- [Finding your way around](guide/interface.md)
- [Search](guide/search.md)
  - [The finder](guide/finder.md)

## The shell

- [Commands by task](shell/commands.md)

## Reference

- [Commands](reference/commands.md)
  - [Core commands](reference/commands-core.md)
- [Settings](reference/settings.md)
- [Glossary](reference/glossary.md)

# Modules

## Archive

- [The Archive](archive/index.md)
- [Albums](archive/albums.md)
- [Commands](archive/commands.md)
`;

Deno.test('the contents keep their parts and sections, and leave out the pages drawn live', () => {
  const guide = parseSummary(SUMMARY);
  assertEquals(guide.sections.map((section) => [section.part, section.title, section.pages.map((page) => page.path)]), [
    ['', '', ['index.md']],
    ['Core', 'Using EiN', ['guide/interface.md', 'guide/search.md', 'guide/finder.md']],
    ['Core', 'The shell', ['shell/commands.md']],
    ['Core', 'Reference', ['reference/glossary.md']],
    ['Modules', 'Archive', ['archive/index.md', 'archive/albums.md']],
  ]);
  assertEquals(guide.pages.find((page) => page.path === 'guide/finder.md')?.depth, 1);
  assertEquals(guide.modules, ['archive']);
  assertEquals(modulePages(guide, 'archive').map((page) => page.title), ['The Archive', 'Albums']);
});

Deno.test('a page has a route without .md, an index its folder, and the route names it back', () => {
  const guide = parseSummary(SUMMARY);
  assertEquals(guideRoute('index.md'), '/docs');
  assertEquals(guideRoute('archive/index.md'), '/docs/archive');
  assertEquals(guideRoute('guide/search.md', 'the-finder'), '/docs/guide/search#the-finder');
  assertEquals(guidePageOf(guide, ''), 'index.md');
  assertEquals(guidePageOf(guide, 'archive'), 'archive/index.md');
  assertEquals(guidePageOf(guide, 'guide/search'), 'guide/search.md');
});

Deno.test('a relative link resolves within the guide and never out of it', () => {
  assertEquals(resolveGuidePath('guide', '../reference/glossary.md'), 'reference/glossary.md');
  assertEquals(resolveGuidePath('guide', './search.md'), 'guide/search.md');
  assertEquals(resolveGuidePath('', '../index.html'), null);
});

Deno.test('a link to a generated reference page goes to the live page, at the same entry', () => {
  assertEquals(liveRoute('reference/commands-core.md', 'share-set'), '/docs/commands#cmd-share-set');
  assertEquals(liveRoute('reference/commands.md'), '/docs/commands');
  assertEquals(liveRoute('reference/settings.md', 'cfg_trash_retention_days'), '/docs/settings#set-CFG_TRASH_RETENTION_DAYS');
  assertEquals(liveRoute('reference/environment.md', 'set-by-the-deployment'), '/docs/environment#env-deployment');
  assertEquals(liveRoute('reference/environment.md', 'no-such-section'), '/docs/environment');
  assertEquals(liveRoute('reference/node-types.md', 'structure'), '/docs/node-types#types-structure');
  assertEquals(liveRoute('reference/node-types.md', 'album'), '/docs/node-types#type-album');
  assertEquals(liveRoute('reference/glossary.md'), undefined);
  assertEquals(liveRoute('archive/commands.md', 'album', ['archive']), '/docs/commands#cmd-album');
  assertEquals(liveRoute('archive/commands.md', '', ['archive']), '/docs/modules/archive#commands');
  assertEquals(liveRoute('shell/commands.md', '', ['archive']), undefined);
});
