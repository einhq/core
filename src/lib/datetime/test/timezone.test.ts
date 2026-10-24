import { assertEquals } from '@std/assert';
import { stampToObject, SYSTEM_TIME_ZONE } from '../mod.ts';
import { pgTest, pgTestContext } from '../../../testing/gates.ts';

type ClockParts = {
  year: string;
  day: string;
  hour: string;
  minute: string;
};

const localClockParts = (timestamp: number): ClockParts => {
  const local = new Date(timestamp);
  return {
    year: String(local.getFullYear()),
    day: String(local.getDate()),
    hour: String(local.getHours()).padStart(2, '0'),
    minute: String(local.getMinutes()).padStart(2, '0'),
  };
};

/**
 * One zone per process, used by every renderer.
 *
 * Three locations turn an instant into date parts and they do it by different mechanisms:
 * `stampToObject` through Temporal with an explicit zone, `logger.ts` and
 * `vfs/query-eval.ts`'s `birthtimeBucket` through `Date`'s local getters.
 *
 * `birthtimeBucket` is the reason this is more than cosmetic: it decides which year a file
 * counts towards, and `stores/pg/query.ts` answers the same question with `to_char` in the
 * session TimeZone. Those buckets have to be the same zone, so the assertion is that the
 * Temporal path and the local-getter path describe the same wall clock — which holds under
 * any `TZ`, and fails the moment one of them is pinned to a zone of its own.
 */
Deno.test('timezone', async (t) => {
  await t.step('stampToObject renders in the same zone Date does', () => {
    // Chosen to sit either side of midnight in most zones, which is where a bucket that
    // disagreed with its neighbour would show up first.
    for (const timestamp of [0, 1787678089522, Date.UTC(2020, 11, 31, 23, 30, 0), Date.UTC(2021, 0, 1, 0, 30, 0)]) {
      const { year, day, hour, minute } = stampToObject(timestamp);
      assertEquals({ year, day, hour, minute }, localClockParts(timestamp), `clock at ${timestamp}`);
    }
  });

  await t.step('a non-UTC process crosses the same year boundary through both APIs', async () => {
    // Do not rely on the test runner's zone: under UTC, a renderer pinned to UTC is
    // indistinguishable from the local Date getters.
    const moduleUrl = new URL('../mod.ts', import.meta.url).href;
    const timestamp = Date.UTC(2021, 0, 1, 0, 30, 0);
    const source = `
      import { stampToObject, SYSTEM_TIME_ZONE } from ${JSON.stringify(moduleUrl)};
      const timestamp = ${timestamp};
      const local = new Date(timestamp);
      const rendered = stampToObject(timestamp);
      console.log(JSON.stringify({
        timezone: SYSTEM_TIME_ZONE,
        rendered: {
          year: rendered.year,
          day: rendered.day,
          hour: rendered.hour,
          minute: rendered.minute,
        },
        local: {
          year: String(local.getFullYear()),
          day: String(local.getDate()),
          hour: String(local.getHours()).padStart(2, '0'),
          minute: String(local.getMinutes()).padStart(2, '0'),
        },
      }));
    `;
    const output = await new Deno.Command(Deno.execPath(), {
      args: ['eval', source],
      env: { TZ: 'America/Los_Angeles' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.success, true, stderr);

    const snapshot = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      timezone: string;
      rendered: ClockParts;
      local: ClockParts;
    };
    assertEquals(snapshot.timezone, 'America/Los_Angeles');
    assertEquals(snapshot.rendered, snapshot.local);
    assertEquals(snapshot.rendered.year, '2020');
  });

  await t.step('the zone is a resolved IANA id, never empty', () => {
    // `Intl` resolves an unset TZ to the host's zone, so this holds with or without one in
    // the environment. It reaches PostgreSQL as `-c timezone=<this>`, which rejects a blank.
    assertEquals(typeof SYSTEM_TIME_ZONE, 'string');
    assertEquals(SYSTEM_TIME_ZONE.length > 0, true);
    assertEquals(Intl.supportedValuesOf('timeZone').includes(SYSTEM_TIME_ZONE) || SYSTEM_TIME_ZONE === 'UTC', true);
  });
});

pgTest('PostgreSQL sessions use the system timezone', async () => {
  const ctx = pgTestContext();
  try {
    const setting = await ctx.pool.query<{ timezone: string }>("SELECT current_setting('TimeZone') AS timezone");
    assertEquals(setting.rows[0].timezone, SYSTEM_TIME_ZONE);

    for (const timestamp of [Date.UTC(2020, 11, 31, 23, 30, 0), Date.UTC(2021, 0, 1, 0, 30, 0)]) {
      const result = await ctx.pool.query<{ clock: string }>(
        "SELECT to_char(to_timestamp($1), 'YYYY-MM-DD HH24:MI') AS clock",
        [timestamp / 1000],
      );
      const local = new Date(timestamp);
      const expected = [
        String(local.getFullYear()).padStart(4, '0'),
        String(local.getMonth() + 1).padStart(2, '0'),
        String(local.getDate()).padStart(2, '0'),
      ].join('-') + ` ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
      assertEquals(result.rows[0].clock, expected, `clock at ${timestamp}`);
    }
  } finally {
    await ctx.teardown();
  }
});
