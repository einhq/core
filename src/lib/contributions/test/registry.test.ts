import { assertEquals } from '@std/assert';
import { completions, registerContributions, unregisterContributions, validateContributions } from '../registry.ts';
import { checkReference } from '../../../modules/validate.ts';
import type { ModuleManifest } from '../../../modules/types.ts';

Deno.test('a module registers what it contributes, and takes it away again', () => {
  // A node type with a root completes by its type; one without is not completed.
  registerContributions('boats', { nodeTypes: [{ type: 'sailboat', root: '/archive/boats' }, { type: 'mast' }] });
  assertEquals(completions(), { sailboat: { type: 'sailboat', root: '/archive/boats' } });

  // A type another module claimed first is declined; the rest is kept.
  registerContributions('rafts', { nodeTypes: [{ type: 'sailboat', root: '/archive/rafts' }, { type: 'dinghy', root: '/archive/dinghies' }] });
  assertEquals(completions().sailboat, { type: 'sailboat', root: '/archive/boats' });
  assertEquals(completions().dinghy, { type: 'dinghy', root: '/archive/dinghies' });

  unregisterContributions('boats');
  unregisterContributions('rafts');
  assertEquals(completions(), {});
});

Deno.test('a malformed declaration is refused whole, with one reason per bad entry', () => {
  const problems = validateContributions({
    nodeTypes: [{ type: 'person', root: 'relative/path' }, { type: 'bad type', root: '/archive/boats' }],
    indexes: [{ name: 'Bad-Name', on: ['a'] }, { name: 'fine', on: [] }],
    roots: ['/archive/people', '/etc', '/archive/a/b', '/archive/../etc'],
  });
  assertEquals(problems.length, 7);
  assertEquals(registerContributions('broken', { nodeTypes: [{ type: 'boat', root: 'relative' }] }), false);
  assertEquals(completions(), {});
});

Deno.test('a trigram index is on one attr, without a collation', () => {
  assertEquals(validateContributions({ indexes: [{ name: 'said', on: ['text'], partial: 'text', using: 'trigram' }] }), []);
  assertEquals(
    validateContributions({
      indexes: [
        { name: 'two', on: ['text', 'name'], using: 'trigram' },
        { name: 'sorted', on: ['text'], using: 'trigram', collation: 'sv' },
        { name: 'other', on: ['text'], using: 'hash' as 'trigram' },
      ],
    }).length,
    3,
  );
});

Deno.test('statistics are on one attr, with no collation or partial', () => {
  assertEquals(validateContributions({ indexes: [{ name: 'deferred', on: ['duplicate.deferred'], using: 'statistics' }] }), []);
  assertEquals(
    validateContributions({
      indexes: [
        { name: 'two', on: ['a', 'b'], using: 'statistics' },
        { name: 'sorted', on: ['a'], using: 'statistics', collation: 'sv' },
        { name: 'partial', on: ['a'], using: 'statistics', partial: 'a' },
      ],
    }).length,
    3,
  );
});

Deno.test('checkReference: contributions are validated at setup', () => {
  const base = { name: 'm', version: '1.0.0' } as ModuleManifest;
  assertEquals(checkReference({ ...base, indexes: [{ name: 'taken', on: ['takenAtUtc'] }] }), { errors: [], warnings: [] });
  assertEquals(checkReference({ ...base, roots: '/archive/x' } as unknown as ModuleManifest).errors, ['m: roots must be an array']);
  const boat = { type: 'boat', label: 'Boat', category: 'content', description: 'A boat.', root: 'relative' } as const;
  assertEquals(checkReference({ ...base, nodeTypes: [boat] }).warnings, ["m: node type 'boat': root must be an absolute path"]);
});
