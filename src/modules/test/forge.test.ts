/**
 * What `mod install` and `mod search` make of an address, a setting and a forge's answers.
 */

import { assertEquals, assertRejects } from '@std/assert';
import {
  fetchCommit,
  fetchRefs,
  ForgeError,
  listModuleRepositories,
  moduleNameOf,
  parseInstallTarget,
  parseRefAdvertisement,
  parseRepository,
  parseSource,
  parseSources,
  parseTokens,
  repositoryOf,
  resolveRef,
} from '../forge.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** One pkt-line: its length in four hex digits, itself included, then the line. */
const pkt = (line: string): string => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

const advertisement = (lines: string[]): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`${pkt('# service=git-upload-pack\n')}0000${lines.map(pkt).join('')}0000`);

Deno.test('a source is an organisation on GitHub, or on another host a Forgejo or Gitea', () => {
  assertEquals(parseSource('https://github.com/einhq'), { kind: 'github', origin: 'https://github.com', owner: 'einhq', url: 'https://github.com/einhq' });
  assertEquals(parseSource('http://forge.example:3000/acme')?.kind, 'gitea');
  assertEquals(parseSource('https://github.com/einhq/module-archive'), undefined);
  assertEquals(parseSource('ssh://git@forge.example/acme'), undefined);

  const { sources, problems } = parseSources('https://github.com/einhq/,  http://forge.example:3000/acme  nonsense');
  assertEquals(sources.map((source) => source.url), ['https://github.com/einhq', 'http://forge.example:3000/acme']);
  assertEquals(problems.length, 1);
  assertEquals(parseSources('').sources, []);
});

Deno.test('a token is kept for its host, with the port', () => {
  const tokens = parseTokens('Forge.Example:3000=abc github.com=xyz broken =nope');
  assertEquals([...tokens], [['forge.example:3000', 'abc'], ['github.com', 'xyz']]);
});

Deno.test('a repository is named by its address, with or without .git, or as GitHub over ssh', () => {
  assertEquals(parseRepository('https://github.com/einhq/module-archive.git')?.repository, 'https://github.com/einhq/module-archive');
  assertEquals(parseRepository('git@github.com:einhq/module-ems.git')?.repository, 'https://github.com/einhq/module-ems');
  assertEquals(parseRepository('http://forge.example:3000/acme/module-x/')?.repository, 'http://forge.example:3000/acme/module-x');
  assertEquals(parseRepository('https://github.com/einhq'), undefined);
  assertEquals(moduleNameOf(parseRepository('https://github.com/einhq/module-archive')!), 'archive');
});

Deno.test('what to install: a name or an address, each perhaps with a ref after its last @', () => {
  assertEquals(parseInstallTarget('archive'), { kind: 'name', name: 'archive', ref: undefined });
  assertEquals(parseInstallTarget('archive@v1.2.0'), { kind: 'name', name: 'archive', ref: 'v1.2.0' });
  const pinned = parseInstallTarget('https://github.com/einhq/module-archive@main');
  assertEquals(pinned, { kind: 'repository', repository: parseRepository('https://github.com/einhq/module-archive')!, ref: 'main' });
  const ssh = parseInstallTarget('git@github.com:einhq/module-ems.git');
  assertEquals('repository' in ssh && ssh.ref, undefined);
  assertEquals('error' in parseInstallTarget('Not A Name'), true);
  assertEquals('error' in parseInstallTarget('archive@'), true);
  assertEquals('error' in parseInstallTarget('https://github.com/einhq'), true);
});

Deno.test("refs come from git's advertisement, and a ref is resolved as git does", () => {
  const refs = parseRefAdvertisement(advertisement([
    `${A} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2\n`,
    `${A} refs/heads/main\n`,
    `${B} refs/heads/v1\n`,
    `${B} refs/tags/v1\n`,
    `${C} refs/tags/v1^{}\n`,
  ]));
  assertEquals(refs.head, A);
  assertEquals(refs.branch, 'main');
  assertEquals(resolveRef(refs), { ref: 'main', commit: A });
  assertEquals(resolveRef(refs, 'HEAD'), { ref: 'main', commit: A });
  // An annotated tag is its commit, and a tag wins over a branch of its name.
  assertEquals(resolveRef(refs, 'v1'), { ref: 'v1', commit: C });
  assertEquals(resolveRef(refs, 'refs/heads/v1'), { ref: 'refs/heads/v1', commit: B });
  assertEquals(resolveRef(refs, B), { ref: B, commit: B });
  assertEquals(resolveRef(refs, 'nothing'), undefined);
  assertEquals(resolveRef(parseRefAdvertisement(advertisement([])), undefined), undefined);
});

Deno.test({
  name: 'a forge is asked with the token for its host only, finds a short commit id, and lists its module repositories',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
    const url = new URL(request.url);
    seen.push({ path: url.pathname, authorization: request.headers.get('authorization') });
    if (url.pathname === '/acme/module-x.git/info/refs') {
      return new Response(advertisement([`${A} HEAD\0symref=HEAD:refs/heads/main\n`, `${A} refs/heads/main\n`]));
    }
    if (url.pathname === `/api/v1/repos/acme/module-x/git/commits/${A.slice(0, 7)}`) return Response.json({ sha: A });
    if (url.pathname === '/api/v1/orgs/acme/repos') {
      return Response.json([
        { name: 'module-x', description: 'X', default_branch: 'main' },
        { name: 'module-old', archived: true },
        { name: 'site', description: 'not a module' },
        { name: 'module-', description: 'no name' },
      ]);
    }
    if (url.pathname === '/api/v1/orgs/person/repos') return new Response('not an organisation', { status: 404 });
    if (url.pathname === '/api/v1/users/person/repos') return Response.json([{ name: 'module-y', default_branch: 'trunk' }]);
    return new Response('nothing here', { status: 404 });
  });
  try {
    const host = `127.0.0.1:${server.addr.port}`;
    const acme = parseSource(`http://${host}/acme`)!;
    const tokens = parseTokens(`${host}=secret elsewhere.example=other`);

    assertEquals((await fetchRefs(repositoryOf(acme, 'module-x'), tokens)).head, A);
    assertEquals(seen.at(-1)?.authorization, 'token secret');
    await fetchRefs(repositoryOf(acme, 'module-x'), parseTokens('elsewhere.example=other'));
    assertEquals(seen.at(-1)?.authorization, null);

    // A commit's id cut short is asked of the API, and one no commit begins is none.
    assertEquals(await fetchCommit(repositoryOf(acme, 'module-x'), A.slice(0, 7), tokens), A);
    assertEquals(seen.at(-1)?.authorization, 'token secret');
    assertEquals(await fetchCommit(repositoryOf(acme, 'module-x'), 'fffffff', tokens), undefined);

    const listed = await listModuleRepositories(acme, tokens);
    assertEquals(listed.map((repository) => [repository.name, repository.branch, repository.description]), [['module-x', 'main', 'X']]);

    // A user is listed where an organisation is not found.
    const person = await listModuleRepositories(parseSource(`http://${host}/person`)!, tokens);
    assertEquals(person.map((repository) => [repository.name, repository.branch]), [['module-y', 'trunk']]);

    const missing = await assertRejects(() => fetchRefs(repositoryOf(acme, 'module-none'), tokens), ForgeError);
    assertEquals(missing.status, 404);
  } finally {
    await server.shutdown();
  }
});
