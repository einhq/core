/**
 * Step commands get the trigger's names substituted in, quoted. A value is
 * inserted once and never scanned again: a file name naming another variable
 * must stay one quoted word, not reopen the quotes (ein/core#1354).
 */

import { assertEquals } from '@std/assert';
import { eventEnv } from '../../../lib/events/mod.ts';
import { shq } from '../../../lib/shell-quote/mod.ts';
import { substitute } from '../substitute.ts';

const quoted = (vars: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, value === '' ? '' : shq(value)]));

Deno.test('a value naming another variable stays one quoted word', () => {
  const file = '/archive/albums/t/x$NODE_PATH$(echo INJECTED-AS-$USER >&2).jpg';
  const env = eventEnv({ id: '01J', type: 'media.face.detected', subject: `${file}/regions/face-0`, time: 0, data: { filePath: file } });

  assertEquals(substitute('assign-faces $EVENT_FILE_PATH', quoted(env)), `assign-faces ${shq(file)}`);
  assertEquals(substitute('assign-faces $NODE_PATH', quoted(env)), `assign-faces ${shq(`${file}/regions/face-0`)}`);
});

Deno.test('the longest name wins and an unknown one is left for the shell', () => {
  const vars = { EVENT_TYPE: 'a', EVENT_TYPE_HINT: 'b' };
  assertEquals(substitute('$EVENT_TYPE_HINT $EVENT_TYPE $EVENT_TYPEX $HOME', vars), 'b a aX $HOME');
  assertEquals(substitute('$EVENT_TYPE', {}), '$EVENT_TYPE');
});
