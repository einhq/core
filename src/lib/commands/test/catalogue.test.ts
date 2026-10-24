import { assertEquals } from '@std/assert';
import { declaresSpec, moduleOf } from '../catalogue.ts';

Deno.test('moduleOf: a module bin directory is that module, anything else core', () => {
  assertEquals(moduleOf('/usr/modules/media/bin', '/usr/modules'), 'media');
  assertEquals(moduleOf('/usr/modules/media/bin/', '/usr/modules/'), 'media');
  assertEquals(moduleOf('/usr/bin', '/usr/modules'), 'core');
  assertEquals(moduleOf('/usr/modules/media/lib', '/usr/modules'), 'core');
  assertEquals(moduleOf(undefined, '/usr/modules'), 'core');
});

Deno.test('declaresSpec: a #!ts bin, or a script that begins with its arg declarations', () => {
  assertEquals(declaresSpec('#!ts\nexport default cmd;\n'), true);
  assertEquals(declaresSpec('#!bash\n# Make a thing\n\narg --desc "Make a thing"\narg --export\n'), true);
  assertEquals(declaresSpec('arg --export\n'), true);
  assertEquals(declaresSpec('#!bash\nmkdir /tmp/x\narg --export\n'), false);
  assertEquals(declaresSpec('#!bash\nargs=1\n'), false);
  assertEquals(declaresSpec(''), false);
});
