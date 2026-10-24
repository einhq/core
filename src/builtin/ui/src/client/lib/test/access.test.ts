import { assertEquals } from '@std/assert';
import { canAccess, canList, canWrite, canWriteEach, describeNodeError, isAccessDenied, type NodeOwnership } from '../access.ts';

const readOnly: NodeOwnership = { uid: 2000, gid: 3000, mode: 0o444 };

Deno.test('canWrite hides edit affordances while identity is loading and for read-only users', () => {
  assertEquals(canWrite(readOnly, null), false);
  assertEquals(canWrite(readOnly, { uid: 2000, gids: [3000] }), false);
  assertEquals(canWrite(readOnly, { uid: 4000, gids: [5000] }), false);
});

Deno.test('canWrite recognizes owner, group, world, and administrator write access', () => {
  assertEquals(canWrite({ ...readOnly, mode: 0o644 }, { uid: 2000, gids: [] }), true);
  assertEquals(canWrite({ ...readOnly, mode: 0o464 }, { uid: 4000, gids: [3000] }), true);
  assertEquals(canWrite({ ...readOnly, mode: 0o446 }, { uid: 4000, gids: [] }), true);
  assertEquals(canWrite(readOnly, { uid: 0, gids: [] }), true);
  assertEquals(canWrite(readOnly, { uid: 4000, gids: [], admin: true }), true);
});

Deno.test('canAccess reads each class of bits, and the access list where other bits are', () => {
  const node = { uid: 2000, gid: 3000, mode: 0o750 };
  assertEquals(canAccess(node, { uid: 2000, gids: [] }, 'x'), true);
  assertEquals(canAccess(node, { uid: 4000, gids: [3000] }, 'r'), true);
  assertEquals(canAccess(node, { uid: 4000, gids: [3000] }, 'w'), false);
  assertEquals(canAccess(node, { uid: 4000, gids: [] }, 'r'), false);
  const shared = { ...node, acl: [{ gid: 5000, mode: 0o5 }] };
  assertEquals(canAccess(shared, { uid: 4000, gids: [5000] }, 'x'), true);
  assertEquals(canAccess(shared, { uid: 4000, gids: [5000] }, 'w'), false);
});

Deno.test('the guest reads what is shared with everyone and writes nothing, even where other may', () => {
  const guest = { uid: 1001, gids: [1001] };
  const open = { uid: 2000, gid: 3000, mode: 0o777 };
  assertEquals(canList(open, guest), true);
  assertEquals(canList({ ...open, mode: 0o770 }, guest), false);
  assertEquals(canWrite(open, guest), false);
  assertEquals(canWriteEach([{ ownership: open }], guest), false);
  // A row whose list carried no ownership is offered to anyone signed in, not to the guest.
  assertEquals(canWriteEach([{}], { uid: 2000, gids: [] }), true);
  assertEquals(canWriteEach([{}], guest), false);
});

Deno.test('canList wants read and execute, and locks nothing before the reader is known', () => {
  const readOnly = { uid: 2000, gid: 3000, mode: 0o744 };
  assertEquals(canList(readOnly, { uid: 2000, gids: [] }), true);
  assertEquals(canList(readOnly, { uid: 4000, gids: [3000] }), false);
  assertEquals(canList(readOnly, null), true);
});

Deno.test('describeNodeError says access and absence plainly and trims the rest', () => {
  assertEquals(describeNodeError(new Error("ls: Access denied for operation 'x' on node: 01ABC")), 'You do not have permission to open this.');
  assertEquals(describeNodeError(new Error('ls: Node not found: /nowhere\n')), 'There is nothing at this path.');
  assertEquals(describeNodeError(new Error('mv: target exists\nmore detail')), 'target exists');
  assertEquals(isAccessDenied(new Error("Access denied for operation 'r' on node: 01ABC")), true);
});
