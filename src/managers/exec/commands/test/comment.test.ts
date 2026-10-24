/**
 * Comment tests: markdown blobs under <owner>/comments/<slug>, author/time from
 * props, ownership check on remove, and who may add one: whoever may change the
 * node, while a reader of it reads the comments.
 */

import { assertEquals } from '@std/assert';
import { encodeBase64 } from '@std/encoding/base64';
import { createTestContext, testCommands } from '../../../../testing/mod.ts';
import type { CommentEntry } from '../../../../lib/comments/mod.ts';

const testCtx = createTestContext({ boot: true });

Deno.test({
  name: 'comments',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec('mkdir -p /scratch && echo hello > /scratch/photo.txt');

    await t.step('add creates a markdown blob and list returns it', async () => {
      await cmd.shouldSucceed('comment add /scratch/photo.txt --body "first thought"');

      const comments = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      assertEquals(comments.length, 1);
      assertEquals(comments[0].body, 'first thought');
      assertEquals(comments[0].author, 'admin');

      const mimetype = await client.execString(
        `attrs /scratch/photo.txt/comments/${comments[0].slug} | jq .mimetype`,
      );
      assertEquals(mimetype.includes('text/markdown'), true, mimetype);
    });

    await t.step('--body-base64 carries multi-line text', async () => {
      const body = 'line one\nline "two"\nline \'three\'';
      await cmd.shouldSucceed(`comment add /scratch/photo.txt --body-base64 ${encodeBase64(body)}`);

      const comments = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      assertEquals(comments.length, 2);
      assertEquals(comments[1].body, body);
    });

    await t.step('list is oldest first and empty without a comments dir', async () => {
      await client.exec('echo other > /scratch/other.txt');
      const none = await client.execJson<CommentEntry[]>('comment list /scratch/other.txt');
      assertEquals(none, []);

      const comments = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      assertEquals(comments[0].createdAt <= comments[1].createdAt, true);
    });

    await t.step('add rejects an empty body', async () => {
      await cmd.shouldFail('comment add /scratch/photo.txt --body "   "');
    });

    await t.step('remove deletes the comment', async () => {
      const comments = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      await cmd.shouldSucceed(`comment remove /scratch/photo.txt ${comments[0].slug}`);

      const remaining = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      assertEquals(remaining.length, 1);
      assertEquals(remaining.some((c) => c.slug === comments[0].slug), false);
    });

    await t.step("remove refuses another user's comment", async () => {
      const comments = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      const slug = comments[0].slug;

      await cmd.shouldSucceed('user-create bob');
      await cmd.shouldSucceed('user-passwd bob --new-password pw123');
      await cmd.shouldSucceed('chmod 777 /scratch/photo.txt/comments');

      const bob = await testCtx.server.createShellClient({ username: 'bob', password: 'pw123' });
      try {
        const result = await bob.exec(`comment remove /scratch/photo.txt ${slug}`);
        assertEquals(result.success, false, JSON.stringify(result));
      } finally {
        bob.close();
      }

      const still = await client.execJson<CommentEntry[]>('comment list /scratch/photo.txt');
      assertEquals(still.length, 1);
    });

    await t.step("the node's group may comment; a reader outside it reads the comments, and may not add one", async () => {
      await cmd.shouldSucceed('group-create family');
      await cmd.shouldSucceed('user-create anna && user-passwd anna --new-password pw123 && group-add-member family anna');
      await cmd.shouldSucceed('user-create carl && user-passwd carl --new-password pw123');
      await client.exec('mkdir -p /scratch/shared && echo picture > /scratch/shared/pic.txt');
      await cmd.shouldSucceed('chmod 755 /scratch /scratch/shared && chown :family /scratch/shared/pic.txt && chmod 775 /scratch/shared/pic.txt');

      const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'pw123' });
      const carl = await testCtx.server.createShellClient({ username: 'carl', password: 'pw123' });
      try {
        await testCommands(anna).shouldSucceed('comment add /scratch/shared/pic.txt --body "from the family"');
        const seen = await carl.execJson<CommentEntry[]>('comment list /scratch/shared/pic.txt');
        assertEquals(seen.map((c) => c.body), ['from the family']);
        await testCommands(carl).shouldFailWith('comment add /scratch/shared/pic.txt --body "from outside"', "Access denied for operation 'w'");
      } finally {
        anna.close();
        carl.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
