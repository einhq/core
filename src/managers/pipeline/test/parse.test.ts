/**
 * parsePipeline: the `pool` step field (delegation to a work pool) and
 * the two trigger forms (`on:` domain events vs `event:` + `nodeType:` VFS).
 */

import { assertEquals, assertThrows } from '@std/assert';
import { eventVarsReferenced, parsePipeline } from '../parse.ts';

const base = (stepBody: string) =>
  [
    'name: p',
    'trigger:',
    '  event: updated',
    '  nodeType: file',
    'steps:',
    '  s:',
    '    command: run $NODE_PATH',
    stepBody,
  ].filter(Boolean).join('\n');

Deno.test('parse: pool is parsed', () => {
  const def = parsePipeline(base('    pool: media'));
  assertEquals(def.steps.s.pool, 'media');
});

Deno.test('parse: pool defaults to undefined', () => {
  const def = parsePipeline(base(''));
  assertEquals(def.steps.s.pool, undefined);
});

Deno.test('parse: empty pool is rejected', () => {
  assertThrows(() => parsePipeline(base('    pool: ""')), Error, 'pool');
});

const withTrigger = (...triggerLines: string[]) =>
  [
    'name: p',
    'trigger:',
    ...triggerLines,
    'steps:',
    '  s:',
    '    command: run $NODE_PATH',
  ].join('\n');

Deno.test('parse: a single domain event trigger', () => {
  const def = parsePipeline(withTrigger('  on: media.metadata.extracted'));

  assertEquals(def.triggers[0].on, ['media.metadata.extracted']);
  assertEquals(def.triggers[0].event, undefined);
  assertEquals(def.triggers[0].nodeType, undefined);
});

Deno.test('parse: a list of domain event triggers', () => {
  const def = parsePipeline(
    withTrigger('  on:', '    - media.file.discovered', '    - media.file.content-changed'),
  );

  assertEquals(def.triggers[0].on, ['media.file.discovered', 'media.file.content-changed']);
});

Deno.test('parse: the vfs trigger form still parses', () => {
  const def = parsePipeline(withTrigger('  event: updated', '  nodeType: file'));

  assertEquals(def.triggers[0].event, 'updated');
  assertEquals(def.triggers[0].nodeType, 'file');
  assertEquals(def.triggers[0].on, undefined);
});

Deno.test('parse: mixing on and event is rejected', () => {
  assertThrows(
    () => parsePipeline(withTrigger('  on: media.file.discovered', '  event: updated', '  nodeType: file')),
    Error,
    'mutually exclusive',
  );
});

Deno.test('parse: nodeType with a domain trigger is rejected', () => {
  assertThrows(
    () => parsePipeline(withTrigger('  on: media.file.discovered', '  nodeType: file')),
    Error,
    'nodeType',
  );
});

Deno.test('parse: a trigger with neither form is rejected', () => {
  assertThrows(() => parsePipeline(withTrigger('  filter: "true"')), Error, 'expected');
});

Deno.test('parse: an empty on list is rejected', () => {
  assertThrows(() => parsePipeline(withTrigger('  on: []')), Error, 'at least one');
});

Deno.test('parse: declarative match accepts a glob and a list of globs', () => {
  const def = parsePipeline(withTrigger('  on: x', '  match:', '    mimetype: image/*', '    kind: [a, b]'));
  assertEquals(def.triggers[0].match, { mimetype: 'image/*', kind: ['a', 'b'] });
});

Deno.test('parse: match must be an object of globs', () => {
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  match: nope')), Error, 'match must be an object');
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  match:', '    mimetype: 3')), Error, 'must be a glob');
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  match:', '    mimetype: []')), Error, 'at least one glob');
});

Deno.test('parse: unless takes the same globs as match and must name a field', () => {
  const def = parsePipeline(withTrigger('  on: x', '  unless:', "    nodePath: '/home/*/staging/**'", '    mimetype: [a/*, b/*]'));
  assertEquals(def.triggers[0].unless, { nodePath: '/home/*/staging/**', mimetype: ['a/*', 'b/*'] });
  assertEquals(def.triggers[0].match, undefined);
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  unless: nope')), Error, 'unless must be an object');
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  unless:', '    nodePath: 3')), Error, 'unless.nodePath must be a glob');
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  unless: {}')), Error, 'unless must name at least one field');
});

Deno.test('parse: a YAML anchor shares one trigger body between events', () => {
  const def = parsePipeline([
    'name: p',
    'triggers:',
    '  - &body',
    '    event: updated',
    '    nodeType: file',
    "    unless: { nodePath: '/home/*/staging/**' }",
    '    skipIfAttr: indexedAt',
    '  - <<: *body',
    '    event: moved',
    'steps:',
    '  s:',
    '    command: run $NODE_PATH',
  ].join('\n'));

  assertEquals(def.triggers, [
    { event: 'updated', nodeType: 'file', unless: { nodePath: '/home/*/staging/**' }, skipIfAttr: 'indexedAt' },
    { event: 'moved', nodeType: 'file', unless: { nodePath: '/home/*/staging/**' }, skipIfAttr: 'indexedAt' },
  ]);
});

Deno.test('parse: skipIfExists and skipIfAttr are parsed and validated', () => {
  const def = parsePipeline(withTrigger('  on: x', '  skipIfExists: $NODE_PATH/faces', '  skipIfAttr: personId'));
  assertEquals(def.triggers[0].skipIfExists, '$NODE_PATH/faces');
  assertEquals(def.triggers[0].skipIfAttr, 'personId');
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  skipIfExists: ""')), Error, 'skipIfExists');
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  skipIfAttr: ""')), Error, 'skipIfAttr');
});

Deno.test('parse: allowDerived is opt-in and must be a boolean', () => {
  // Absent means excluded — the guard is default-on, so the field only ever
  // turns the exclusion off.
  assertEquals(parsePipeline(withTrigger('  on: x')).triggers[0].allowDerived, undefined);
  assertEquals(parsePipeline(withTrigger('  on: x', '  allowDerived: true')).triggers[0].allowDerived, true);
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  allowDerived: yes please')), Error, 'allowDerived');
});

Deno.test('parse: multiple triggers keep independent guards, vars and priorities', () => {
  const def = parsePipeline([
    'name: p',
    'vars:',
    "  FORCE: ''",
    'triggers:',
    '  - on: media.ready',
    '    skipIfExists: $NODE_PATH/result',
    '  - on: media.stale',
    '    vars:',
    '      FORCE: -f',
    '    priority: 10',
    'steps:',
    '  s:',
    '    command: run $FORCE $NODE_PATH',
  ].join('\n'));

  assertEquals(def.triggers, [
    { on: ['media.ready'], skipIfExists: '$NODE_PATH/result' },
    { on: ['media.stale'], vars: { FORCE: '-f' }, priority: 10 },
  ]);
});

Deno.test('parse: trigger overrides must be declared and priority must be finite', () => {
  assertThrows(
    () =>
      parsePipeline([
        'name: p',
        'triggers:',
        '  - on: x',
        '    vars: { FORCE: -f }',
        'steps:',
        '  s:',
        '    command: run',
      ].join('\n')),
    Error,
    "declares no variable 'FORCE'",
  );
  assertThrows(() => parsePipeline(withTrigger('  on: x', '  priority: nope')), Error, 'priority');
});

const withVars = (...varLines: string[]) =>
  [
    'name: p',
    'trigger:',
    '  event: updated',
    '  nodeType: file',
    'vars:',
    ...varLines,
    'steps:',
    '  s:',
    '    command: run $NODE_PATH $FORCE',
  ].join('\n');

Deno.test('parse: vars carry their defaults, empty written either way', () => {
  const def = parsePipeline(withVars("  FORCE: ''", '  EMPTY:', '  ONLY: preview', '  LIMIT: 3', '  DRY: true'));

  assertEquals(def.vars, { FORCE: '', EMPTY: '', ONLY: 'preview', LIMIT: '3', DRY: 'true' });
});

Deno.test('parse: no vars block leaves vars undefined', () => {
  assertEquals(parsePipeline(base('')).vars, undefined);
});

Deno.test('parse: vars must be an object of NAME: default', () => {
  assertThrows(() => parsePipeline(withVars('  nope')), Error, 'invalid vars');
  assertThrows(() => parsePipeline(withVars('  FORCE: [a]')), Error, 'must be a string');
  assertThrows(() => parsePipeline(withVars('  not-a-name: x')), Error, 'not a valid variable name');
});

Deno.test('parse: a var cannot shadow a name the trigger sets', () => {
  // Silently losing to the trigger env is worse than not starting: the step
  // would run with a value nobody wrote.
  for (const name of ['NODE_PATH', 'PATH', 'MIMETYPE', 'NODE_TYPE', 'EVENT_TYPE']) {
    assertThrows(() => parsePipeline(withVars(`  ${name}: x`)), Error, 'set by the trigger');
  }
});

const withEntryPoint = (...optionLines: string[]) =>
  [
    'name: p',
    'trigger:',
    '  event: updated',
    '  nodeType: file',
    'steps:',
    '  s:',
    '    command: run',
    'options:',
    ...optionLines,
  ].join('\n');

Deno.test('parse: entryPoint accepts the bare boolean', () => {
  assertEquals(parsePipeline(withEntryPoint('  entryPoint: true')).options?.entryPoint, true);
  assertEquals(parsePipeline(withEntryPoint('  entryPoint: false')).options?.entryPoint, false);
});

Deno.test('parse: entryPoint carries the coverage declaration', () => {
  const def = parsePipeline(
    withEntryPoint('  entryPoint:', '    kinds: [photo, video, photo]', '    marker: exif'),
  );

  // Deduplicated, because a repeated kind would be counted twice into the
  // denominator and quietly halve the reported coverage.
  assertEquals(def.options?.entryPoint, { kinds: ['photo', 'video'], marker: 'exif' });
});

Deno.test('parse: entryPoint names the attr of the files it exempts from coverage', () => {
  const def = parsePipeline(withEntryPoint('  entryPoint:', '    kinds: [photo]', '    marker: exif', '    exempt: duplicate.deferred'));
  assertEquals(def.options?.entryPoint, { kinds: ['photo'], marker: 'exif', exempt: 'duplicate.deferred' });
  assertThrows(() => parsePipeline(withEntryPoint('  entryPoint:', '    kinds: [photo]', '    marker: exif', '    exempt: duplicate-deferred')), Error, 'not an attr name');
  assertThrows(() => parsePipeline(withEntryPoint('  entryPoint:', '    kinds: [photo]', '    marker: exif', '    exempt: 3')), Error, 'exempt must name an attr');
});

Deno.test('parse: entryPoint rejects a declaration it cannot measure', () => {
  // A typo'd kind must not just drop out of the denominator: the whole point of
  // the declaration is that the coverage figure is not quietly wrong.
  assertThrows(() => parsePipeline(withEntryPoint('  entryPoint:', '    kinds: [photos]', '    marker: exif')), Error, "unknown kind 'photos'");
  assertThrows(() => parsePipeline(withEntryPoint('  entryPoint:', '    kinds: []', '    marker: exif')), Error, 'non-empty list');
  assertThrows(() => parsePipeline(withEntryPoint('  entryPoint:', '    kinds: [photo]')), Error, 'marker');
  assertThrows(() => parsePipeline(withEntryPoint('  entryPoint: [photo]')), Error, 'expected a boolean');
});

Deno.test('parse: eventVarsReferenced names every EVENT_ var a definition reads', () => {
  const def = parsePipeline(
    [
      'name: p',
      'trigger:',
      '  on: thing.happened',
      '  skipIfExists: $EVENT_FILE_PATH/faces',
      'steps:',
      '  a:',
      '    command: assign-faces $EVENT_FILE_PATH',
      '    condition: test -n "$EVENT_LABEL"',
      '  b:',
      '    command: echo $EVENT_FILE_PATH $NODE_PATH $FORCE',
      'vars:',
      "  FORCE: ''",
    ].join('\n'),
  );

  // Sorted and deduplicated across steps, commands and conditions; `$NODE_PATH`
  // and a declared var are not event vars and must not be reported as missing.
  assertEquals(eventVarsReferenced(def), ['EVENT_FILE_PATH', 'EVENT_LABEL']);
});

Deno.test('parse: eventVarsReferenced is empty for a definition that reads none', () => {
  assertEquals(eventVarsReferenced(parsePipeline(base(''))), []);
});

Deno.test('parse: coalesce and debounceMs are carried and validated', () => {
  const def = parsePipeline(withEntryPoint('  coalesce: rerun', '  debounceMs: 5000'));
  assertEquals(def.options?.coalesce, 'rerun');
  assertEquals(def.options?.debounceMs, 5000);

  assertEquals(parsePipeline(withEntryPoint('  coalesce: drop')).options?.coalesce, 'drop');
  assertThrows(() => parsePipeline(withEntryPoint('  coalesce: merge')), Error, "expected 'drop' or 'rerun'");
  assertThrows(() => parsePipeline(withEntryPoint('  debounceMs: -1')), Error, 'non-negative');
  assertThrows(() => parsePipeline(withEntryPoint('  debounceMs: soon')), Error, 'non-negative');
});
