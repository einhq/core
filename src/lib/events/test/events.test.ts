/**
 * Domain event envelope: shape detection and the shell env a trigger sees.
 */

import { assertEquals } from '@std/assert';
import { type DomainEvent, eventEnv, isDomainEvent } from '../mod.ts';

const event: DomainEvent = {
  id: '01J',
  type: 'media.metadata.extracted',
  subject: `/archive/albums/x/a.jpg`,
  time: 1700000000000,
  source: 'archive-bridge',
  data: {
    mimetype: 'image/jpeg',
    width: 4032,
    hasGps: true,
    deviceSerial: 'ABC123',
    takenAt: null,
    faceBox: [1, 2, 3, 4],
  },
};

Deno.test('isDomainEvent distinguishes facts from slim vfs events', () => {
  assertEquals(isDomainEvent(event), true);
  assertEquals(isDomainEvent({ type: 'updated', path: '/a.jpg', nodeType: 'file' }), false);
  assertEquals(isDomainEvent(null), false);
  assertEquals(isDomainEvent('media.file.discovered'), false);
});

Deno.test('eventEnv exposes the subject as NODE_PATH', () => {
  assertEquals(eventEnv(event).NODE_PATH, `/archive/albums/x/a.jpg`);
});

Deno.test('eventEnv flattens data to EVENT_<UPPER_SNAKE>', () => {
  const env = eventEnv(event);

  assertEquals(env.EVENT_TYPE, 'media.metadata.extracted');
  assertEquals(env.EVENT_ID, '01J');
  assertEquals(env.EVENT_SOURCE, 'archive-bridge');
  assertEquals(env.EVENT_MIMETYPE, 'image/jpeg');
  assertEquals(env.EVENT_WIDTH, '4032');
  assertEquals(env.EVENT_HAS_GPS, 'true');
  assertEquals(env.EVENT_DEVICE_SERIAL, 'ABC123');
  // A null value must read as absent, not the string "null"
  assertEquals(env.EVENT_TAKEN_AT, '');
  // Structured values stay JSON so a filter can pipe them to jq
  assertEquals(env.EVENT_FACE_BOX, '[1,2,3,4]');
  assertEquals(JSON.parse(env.EVENT_DATA).mimetype, 'image/jpeg');
});

Deno.test('eventEnv survives an event with no data', () => {
  const env = eventEnv({ id: '01J', type: 'media.file.removed', subject: '/a.jpg', time: 1 });

  assertEquals(env.NODE_PATH, '/a.jpg');
  assertEquals(env.EVENT_DATA, '');
  assertEquals(env.EVENT_SOURCE, '');
});

Deno.test('eventEnv does not let a data key shadow the envelope', () => {
  const env = eventEnv({
    id: '01J',
    type: 'media.file.discovered',
    subject: '/real.jpg',
    time: 1,
    data: { type: 'spoofed', 'node-path': '/spoofed.jpg' },
  });

  assertEquals(env.EVENT_TYPE, 'media.file.discovered');
  assertEquals(env.NODE_PATH, '/real.jpg');
});
