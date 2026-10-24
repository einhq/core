/**
 * `parse-search` asks the command `CFG_SEARCH_PARSER` names, and with none answers the words as
 * words — so the search box needs no module to search. A module names its parser in its own
 * settings file (`/etc/config.d/<module>`), which the administrator's `/etc/config` overrides.
 */
import { assertEquals } from '@std/assert';
import type { SearchParse } from '../../../../lib/api/search.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { ConfigEntry } from '../../../../lib/config/types.ts';
import { createTestContext } from '../../../../testing/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({ name: 'parse-search', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    await t.step('without a parser the words are the words', async () => {
      const parsed = await client.execJson<SearchParse>("parse-search 'Anna Andersson 2015'");
      assertEquals(parsed, { text: 'Anna Andersson 2015', kinds: [], subjects: [], unresolved: [], source: 'none', explain: '' });
    });

    await t.step('with one, its reading is the answer, and --rules is passed on', async () => {
      await client.exec('mkdir -p /opt/bin');
      await client.exec('mkfile /opt/bin/fake-parse && chmod 755 /opt/bin/fake-parse');
      const handle = await vfs.open(ADMIN_ACCESS, '/opt/bin/fake-parse', { mode: 'w' });
      try {
        // The rules pass reads the year; the full read finds the person too.
        await handle.write(new TextEncoder().encode(
          `if [ "$1" = --rules ]; then echo '{"text":"Anna Andersson","kinds":[],"from":"2015","to":"2015","subjects":[],"unresolved":[],"source":"rules","explain":"in 2015"}'; ` +
            `else echo '{"text":"","kinds":[],"from":"2015","to":"2015","subjects":[{"kind":"person","name":"Anna Andersson","ref":"anna-andersson","matches":[]}],"unresolved":[],"source":"llm","explain":"Anna Andersson in 2015"}'; fi\n`,
        ));
      } finally {
        await handle.close();
      }
      await client.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
      // What a module's etc/config becomes once mod setup has linked it.
      await client.exec(`mkdir -p /etc/config.d && echo "export CFG_SEARCH_PARSER='fake-parse'" > /etc/config.d/fake`);

      const parser = await testCtx.server.createShellClient();
      try {
        assertEquals((await parser.execJson<SearchParse>("parse-search --rules 'Anna Andersson 2015'")).source, 'rules');
        const full = await parser.execJson<SearchParse>("parse-search 'Anna Andersson 2015'");
        assertEquals([full.source, full.subjects[0]?.ref, full.text], ['llm', 'anna-andersson', '']);
      } finally {
        parser.close();
      }
    });

    await t.step('the settings say which module chose the parser', async () => {
      const entry = await client.execJson<ConfigEntry>('config get CFG_SEARCH_PARSER');
      assertEquals([entry.value, entry.source, entry.sourceModule], ['fake-parse', 'module', 'fake']);
    });

    await t.step("the administrator's setting wins over the module's", async () => {
      await client.exec(`echo "export CFG_SEARCH_PARSER=''" > /etc/config`);
      assertEquals((await client.execJson<SearchParse>("parse-search 'Anna Andersson 2015'")).source, 'none');
      assertEquals((await client.execJson<ConfigEntry>('config get CFG_SEARCH_PARSER')).source, 'system');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
