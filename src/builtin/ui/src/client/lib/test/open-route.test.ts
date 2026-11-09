/** Which route opens a node: core's for a device, a module's for a folder it is under or for its type. */

import { assertEquals } from '@std/assert';
import { nodeRoutes, openRoute } from '../../signals/module-ui.ts';

Deno.test('open route: a folder key wins over the type, the longest folder over a shorter, and {rest} is the path below it', () => {
  nodeRoutes.value = {
    person: '/people/{name}',
    file: '/files/{path}',
    '/etc/things/': '/things/{rest}',
    '/etc/things/deep/': '/deep/{rest}?in={parent}',
  };
  assertEquals(openRoute('file', '/etc/things/hall-light.yaml'), '/things/hall-light');
  assertEquals(openRoute('file', '/etc/things/deep/a.b.yaml'), '/deep/a.b?in=deep');
  assertEquals(openRoute('file', '/etc/things/mod/x.yaml'), '/things/mod%2Fx');
  assertEquals(openRoute('directory', '/etc/things'), null);
  assertEquals(openRoute('person', '/archive/people/Anna Andersson'), '/people/Anna%20Andersson');
  assertEquals(openRoute('file', '/home/anna/notes.md'), '/files/%2Fhome%2Fanna%2Fnotes.md');
  assertEquals(openRoute('device', '/dev/hall-plug'), '/devices/hall-plug');
  nodeRoutes.value = {};
});
