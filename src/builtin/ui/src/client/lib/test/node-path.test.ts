import { assertEquals } from '@std/assert';
import { baseName, dropAllowed, isInside, joinPath, nameProblem, normalizePath, parentPath, pathCrumbs } from '../node-path.ts';

Deno.test('node path: normalize collapses separators and dot segments', () => {
  assertEquals(normalizePath('/a//b/../c/'), '/a/c');
  assertEquals(normalizePath('a/./b'), '/a/b');
  assertEquals(normalizePath('/../..'), '/');
  assertEquals(normalizePath(''), '/');
});

Deno.test('node path: join, parent and base name treat the root specially', () => {
  assertEquals(joinPath('/', 'a'), '/a');
  assertEquals(joinPath('/a', 'b'), '/a/b');
  assertEquals(parentPath('/'), '/');
  assertEquals(parentPath('/a'), '/');
  assertEquals(parentPath('/a/b'), '/a');
  assertEquals(baseName('/a/b'), 'b');
  assertEquals(baseName('/'), '');
});

Deno.test('node path: crumbs walk from the root down', () => {
  assertEquals(pathCrumbs('/'), []);
  assertEquals(pathCrumbs('/a/b'), [{ name: 'a', path: '/a' }, { name: 'b', path: '/a/b' }]);
});

Deno.test('node path: isInside is inclusive and segment-aware', () => {
  assertEquals(isInside('/a/b', '/a'), true);
  assertEquals(isInside('/a', '/a'), true);
  assertEquals(isInside('/ab', '/a'), false);
  assertEquals(isInside('/anything', '/'), true);
});

Deno.test('node path: a drop is refused onto itself, its subtree, or its own parent', () => {
  assertEquals(dropAllowed(['/a/b'], '/a/b'), false);
  assertEquals(dropAllowed(['/a/b'], '/a/b/c'), false);
  assertEquals(dropAllowed(['/a/b'], '/a'), false);
  assertEquals(dropAllowed(['/a/b'], '/x'), true);
  assertEquals(dropAllowed(['/a/b', '/x/y'], '/x'), false);
  assertEquals(dropAllowed([], '/x'), false);
});

Deno.test('node path: a name is refused when empty, with a slash or NUL, or a dot entry', () => {
  assertEquals(nameProblem('photo.jpg'), null);
  assertEquals(nameProblem('.hidden'), null);
  assertEquals(nameProblem(''), 'A name is needed');
  assertEquals(nameProblem('a/b'), 'A name cannot contain /');
  assertEquals(nameProblem('a\0b'), 'A name cannot contain /');
  assertEquals(nameProblem('.'), 'Not a name');
  assertEquals(nameProblem('..'), 'Not a name');
});
