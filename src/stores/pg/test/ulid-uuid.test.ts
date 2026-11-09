import { assertEquals, assertThrows } from '@std/assert';
import { decodeTime, monotonicUlid, ulid } from '@std/ulid';
import { ulidToUuid, uuidAtTime, uuidTime, uuidToUlid } from '../ulid-uuid.ts';

Deno.test('a ULID kept as a uuid', async (t) => {
  await t.step('converts both ways', () => {
    assertEquals(ulidToUuid('01ARZ3NDEKTSV4RRFFQ69G5FAV'), '01563e3a-b5d3-d676-4c61-efb99302bd5b');
    assertEquals(uuidToUlid('01563e3a-b5d3-d676-4c61-efb99302bd5b'), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    assertEquals(ulidToUuid('00000000000000000000000000'), '00000000-0000-0000-0000-000000000000');
    assertEquals(ulidToUuid('7ZZZZZZZZZZZZZZZZZZZZZZZZZ'), 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    for (let i = 0; i < 200; i++) {
      const id = ulid();
      assertEquals(uuidToUlid(ulidToUuid(id)), id);
    }
  });

  await t.step('sorts as the ULIDs do', () => {
    const ids = Array.from({ length: 200 }, () => monotonicUlid());
    assertEquals(ids.map(ulidToUuid), ids.toSorted().map(ulidToUuid));
    assertEquals(ids.map(ulidToUuid).toSorted(), ids.map(ulidToUuid));
  });

  await t.step('keeps the time, and bounds a millisecond', () => {
    const at = Date.UTC(2026, 10, 9, 12);
    const id = ulid(at);
    assertEquals(uuidTime(ulidToUuid(id)), decodeTime(id));
    assertEquals(uuidAtTime(at) <= ulidToUuid(id), true);
    assertEquals(ulidToUuid(id) < uuidAtTime(at + 1), true);
  });

  await t.step('refuses what is not a ULID', () => {
    assertThrows(() => ulidToUuid('r1'));
    assertThrows(() => ulidToUuid('01ARZ3NDEKTSV4RRFFQ69G5FAU'.replace('U', 'I')));
    assertThrows(() => ulidToUuid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ'));
  });
});
