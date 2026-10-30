/** Turning a command's spec into a tool schema, and back into the line the archive runs, on literal specs. */

import { assert, assertEquals } from '@std/assert';
import { toolCallToCommandLine, toolSchema } from '../tool-schema.ts';
import type { CmdSpec } from '../types.ts';

const SEARCH: CmdSpec = {
  name: 'search',
  description: 'Faceted search over content: text, time, region, kind, tags, subjects and containers',
  args: [{ name: 'query', type: 'string', description: 'search query text', optional: true }],
  flags: [
    { name: 'l', type: 'number', description: 'page size (default 60, max 200)' },
    { name: 'limit', type: 'number', description: 'page size (default 60, max 200)' },
    { name: 'kind', type: 'string', description: 'content kind, comma-separated: photo, video' },
    { name: 'subject', type: 'string', description: 'media a subject has, as <kind>:<ref> (repeatable, intersected)', repeatable: true },
    { name: 'facets', type: 'bool', description: 'answer with per-year and per-kind counts' },
  ],
  examples: ['search segelbåt --kind photo'],
  returns: 'a page of matching media, each with its path, name and date.',
};

Deno.test('a spec becomes a schema a model can call', () => {
  const schema = toolSchema(SEARCH);
  assertEquals(schema.name, 'search');
  // The query is the command's own argument, not a flag.
  assertEquals(schema.parameters.properties.query.type, 'string');
  // Repeatable: a list, or "me and my father" could name only one of them.
  assertEquals(schema.parameters.properties.subject.type, 'array');
  assertEquals(schema.parameters.properties.subject.items, { type: 'string' });
  assertEquals(schema.parameters.properties.facets.type, 'boolean');
  assert(!schema.parameters.required.includes('query'), 'an argument the spec marks optional is not required');
  assert(schema.description.includes('Returns:'), 'the description carries what comes back');
  assert(schema.description.includes('search segelbåt'), 'and an example');
  // -l and --limit say the same thing; offering both makes a model pick at random.
  assert(!schema.parameters.properties.l, 'single-letter aliases are dropped');
  assert(schema.parameters.properties.limit, 'the long name survives');
});

Deno.test('an argument is required unless the spec marks it optional, whatever its help says', () => {
  const optional = toolSchema({ name: 'dayinhistory', args: [{ name: 'day', type: 'string', description: 'day as MM-DD', optional: true }] });
  assertEquals(optional.parameters.required, []);
  const served = toolSchema({ name: 'http-server', args: [{ name: 'path', type: 'path', description: 'root to serve, "default" in it the default host' }] });
  assertEquals(served.parameters.required, ['path']);
});

Deno.test('a required argument is required', () => {
  const schema = toolSchema({ name: 'person-info', args: [{ name: 'target', type: 'path', description: 'VFS path to person node' }] });
  assertEquals(schema.parameters.required, ['target']);
  assertEquals(schema.parameters.properties.target.type, 'string');
});

Deno.test('a variadic argument is a list', () => {
  const schema = toolSchema({ name: 'rm', args: [{ name: 'paths', type: 'path', description: 'what to remove', variadic: true }] });
  assertEquals(schema.parameters.properties.paths.type, 'array');
});

Deno.test('a value starting with a dash is attached with =', () => {
  const spec: CmdSpec = { name: 'search', flags: [{ name: 'bbox', type: 'string', description: 'north,south,east,west' }] };
  // South of the equator: as a separate word the shell would read the box as another flag.
  assertEquals(toolCallToCommandLine(spec, { bbox: '-33.8,-34.1,18.6,18.3' }), 'search --bbox=-33.8,-34.1,18.6,18.3');
});

Deno.test('a switch is on or off whatever form it was written in', () => {
  // "True" as a string is a switch turned on, not a stray word on the line.
  assertEquals(toolCallToCommandLine(SEARCH, { query: 'x', facets: 'True' }), 'search --facets x');
  assertEquals(toolCallToCommandLine(SEARCH, { query: 'x', facets: 'false' }), 'search x');
  // A value-taking flag is never read as a switch, even when its value looks like one.
  assertEquals(toolCallToCommandLine(SEARCH, { kind: 'true' }), 'search --kind=true');
});

Deno.test('a tool call becomes the command line the archive runs', () => {
  assertEquals(
    toolCallToCommandLine(SEARCH, { query: 'segelbåt', kind: 'photo', subject: ['person:anna', 'person:bo'], facets: true }),
    "search --kind=photo --subject=person:anna --subject=person:bo --facets 'segelbåt'",
  );
  // A switch that is off is simply absent, and an empty value is not passed at all.
  assertEquals(toolCallToCommandLine(SEARCH, { query: 'x', facets: false, kind: '' }), 'search x');
  assertEquals(
    toolCallToCommandLine({ name: 'person-info', args: [{ name: 'target', type: 'path', description: 'p' }] }, { target: '/archive/people/Bo_Exempel' }),
    'person-info /archive/people/Bo_Exempel',
  );
});
