/**
 * A module's navigation entries (`ui/nav.json`) are linked into /etc/ui/nav.d by `mod setup`, and
 * its drop-in directories (`etc/<x>.d`) as /etc/<x>.d/<module>; both owned by link target like its
 * services and pipelines, and undone by `mod remove` and by the prune of a module whose code is gone. A module's `ui/` is served as a site only when it is
 * one — it may as well hold the sources of the module's pages.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { UI_NAV_D_PATH, WWW_PATH } from '../../../../lib/paths.ts';
import { createTestContext, type ShellClient } from '../../../../testing/mod.ts';

const testCtx = createTestContext();

Deno.test({ name: 'mod setup links navigation', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const id = crypto.randomUUID().slice(0, 8);
  const nav = '{"sidebar":[{"id":"x.page","section":"main","label":"X","icon":"x","to":"/x"}]}';

  const target = async (path: string): Promise<string | undefined> => {
    try {
      const node = await vfs.get(ADMIN_ACCESS, path, { follow: false });
      return typeof node.props.softlink === 'string' ? node.props.softlink : 'not a link';
    } catch {
      return undefined;
    }
  };
  const makeModule = async (dir: string, name: string) => {
    await client.exec(`mkdir -p ${dir}/ui && echo '{"name":"${name}","version":"1.0.0"}' > ${dir}/mod.json && echo '${nav}' > ${dir}/ui/nav.json`);
  };

  try {
    await t.step('setup links the fragment; ui/ without index.html is no site', async () => {
      const name = `nav-${id}`;
      await makeModule(`$MOD_PATH/${name}`, name);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), `/usr/modules/${name}/ui/nav.json`);
      assertEquals(await target(`${WWW_PATH}/${name}`), undefined);

      // Twice is the same as once.
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), `/usr/modules/${name}/ui/nav.json`);
    });

    await t.step('a built site is linked into /www', async () => {
      const name = `site-${id}`;
      await makeModule(`$MOD_PATH/${name}`, name);
      await client.exec(`echo '<html></html>' > $MOD_PATH/${name}/ui/index.html`);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`${WWW_PATH}/${name}`), `/usr/modules/${name}/ui`);
    });

    await t.step('a /www link to a ui/ that is no site is retired', async () => {
      const name = `site-${id}`;
      await client.exec(`rm $MOD_PATH/${name}/ui/index.html`);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`${WWW_PATH}/${name}`), undefined);
    });

    await t.step('a module that stops shipping navigation loses the link', async () => {
      const name = `nav-${id}`;
      await client.exec(`rm $MOD_PATH/${name}/ui/nav.json`);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), undefined);
    });

    await t.step("an operator's file in its place is left alone", async () => {
      const name = `op-${id}`;
      await makeModule(`$MOD_PATH/${name}`, name);
      await client.exec(`mkdir -p ${UI_NAV_D_PATH} && echo '{}' > ${UI_NAV_D_PATH}/${name}.json`);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), 'not a link');
      await client.exec(`mod-remove --force ${name}`);
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), 'not a link');
    });

    await t.step('mod remove unlinks it', async () => {
      const name = `rm-${id}`;
      await makeModule(`$MOD_PATH/${name}`, name);
      await client.exec(`mod-setup ${name}`);
      assert(await target(`${UI_NAV_D_PATH}/${name}.json`));
      await client.exec(`mod-remove --force ${name}`);
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), undefined);
    });

    await t.step('a drop-in directory is linked as /etc/<x>.d/<module>, and taken back when it is no longer shipped', async () => {
      const name = `drop-${id}`;
      await makeModule(`$MOD_PATH/${name}`, name);
      await client.exec(`mkdir -p $MOD_PATH/${name}/etc/thing.d && echo hello > $MOD_PATH/${name}/etc/thing.d/note`);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`/etc/thing.d/${name}`), `/usr/modules/${name}/etc/thing.d`);
      assertEquals(`${(await client.exec(`cat /etc/thing.d/${name}/note`)).data}`.trim(), 'hello');
      // Linked, not copied over /etc/thing.d.
      assertEquals(await target('/etc/thing.d/note'), undefined);
      await client.exec(`rm -r $MOD_PATH/${name}/etc/thing.d`);
      assertEquals((await client.exec(`mod-setup ${name}`)).success, true);
      assertEquals(await target(`/etc/thing.d/${name}`), undefined);

      await client.exec(`mkdir -p $MOD_PATH/${name}/etc/thing.d`);
      await client.exec(`mod-setup ${name}`);
      assert(await target(`/etc/thing.d/${name}`));
      await client.exec(`mod-remove --force ${name}`);
      assertEquals(await target(`/etc/thing.d/${name}`), undefined);
    });

    await t.step('a module whose code is gone is pruned, navigation included', async () => {
      const name = `gone-${id}`;
      const source = `/tmp/${name}`;
      await makeModule(source, name);
      await client.exec(`ln -s ${source} $MOD_PATH/${name} && mod-setup ${name}`);
      assert(await target(`${UI_NAV_D_PATH}/${name}.json`));
      await client.exec(`rm -rf ${source}`);
      await client.exec('mod-setup --all');
      assertEquals(await target(`${UI_NAV_D_PATH}/${name}.json`), undefined);
    });
  } finally {
    await testCtx.teardown();
  }
});
