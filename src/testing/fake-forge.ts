/**
 * A forge that answers as Forgejo does, for the tests of `mod install` and `mod search`: git's ref
 * advertisement over smart HTTP, `/archive/<commit>.tar.gz` under one top directory, an
 * organisation's repositories, a file at a branch and the commit a short id begins in its API. A repository may be private,
 * read only with its token.
 */

import { encodeHex } from '@std/encoding/hex';
import { TarStream, type TarStreamInput } from '@std/tar/tar-stream';
import { MODULE_API_VERSION } from '../modules/types.ts';

export type Files = Record<string, string | { text: string; mode: number }>;

type FakeRepository = {
  branches: Map<string, string>;
  tags: Map<string, string>;
  commits: Map<string, Files>;
  description: string;
  /** Read only with this token, as a private repository is. */
  token?: string;
};

/** A forge of a few organisations, each repository a branch or two and tags over whole trees. */
export class FakeForge {
  readonly repositories = new Map<string, FakeRepository>();
  /** The archives fetched, as `owner/name@commit`. */
  readonly archives: string[] = [];
  private server?: Deno.HttpServer<Deno.NetAddr>;
  private counter = 0;

  get host(): string {
    return `127.0.0.1:${this.server!.addr.port}`;
  }

  url(owner: string): string {
    return `http://${this.host}/${owner}`;
  }

  /** A new commit of `files` on `branch` of `owner/name`, and its id. */
  async publish(owner: string, name: string, files: Files, opts: { branch?: string; tag?: string; token?: string; description?: string } = {}): Promise<string> {
    const key = `${owner}/${name}`;
    const repository = this.repositories.get(key) ??
      { branches: new Map(), tags: new Map(), commits: new Map(), description: opts.description ?? '', token: opts.token };
    this.repositories.set(key, repository);
    const commit = encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${key}:${this.counter++}`))));
    repository.commits.set(commit, files);
    repository.branches.set(opts.branch ?? 'main', commit);
    if (opts.tag) repository.tags.set(opts.tag, commit);
    return commit;
  }

  start(): void {
    this.server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => this.answer(request));
  }

  async stop(): Promise<void> {
    await this.server?.shutdown();
  }

  private answer(request: Request): Response {
    const url = new URL(request.url);
    const allowed = (repository: FakeRepository) => !repository.token || request.headers.get('authorization') === `token ${repository.token}`;

    const refs = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(url.pathname);
    if (refs) {
      const repository = this.repositories.get(`${refs[1]}/${refs[2]}`);
      if (!repository) return new Response('Not found', { status: 404 });
      if (!allowed(repository)) return new Response('Unauthorized', { status: 401 });
      return new Response(advertise(repository));
    }

    const archive = /^\/([^/]+)\/([^/]+)\/archive\/([0-9a-f]{40})\.tar\.gz$/.exec(url.pathname);
    if (archive) {
      const repository = this.repositories.get(`${archive[1]}/${archive[2]}`);
      const files = repository?.commits.get(archive[3]);
      if (!repository || !files || !allowed(repository)) return new Response('Not found', { status: 404 });
      this.archives.push(`${archive[1]}/${archive[2]}@${archive[3]}`);
      return new Response(tarball(archive[2], files));
    }

    const list = /^\/api\/v1\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (list) {
      const listed = [...this.repositories].filter(([key]) => key.startsWith(`${list[1]}/`));
      if (listed.length === 0) return new Response('Not found', { status: 404 });
      return Response.json(listed.map(([key, repository]) => ({ name: key.split('/')[1], description: repository.description, default_branch: 'main' })));
    }

    const commit = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/.exec(url.pathname);
    if (commit) {
      const repository = this.repositories.get(`${commit[1]}/${commit[2]}`);
      const matching = repository && allowed(repository) ? [...repository.commits.keys()].filter((id) => id.startsWith(commit[3])) : [];
      return matching.length === 1 ? Response.json({ sha: matching[0] }) : new Response('Not found', { status: 404 });
    }

    const raw = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(url.pathname);
    if (raw) {
      const repository = this.repositories.get(`${raw[1]}/${raw[2]}`);
      const commit = repository?.branches.get(url.searchParams.get('ref') ?? 'main');
      const file = commit ? repository!.commits.get(commit)?.[raw[3]] : undefined;
      if (file === undefined) return new Response('Not found', { status: 404 });
      return new Response(typeof file === 'string' ? file : file.text);
    }
    return new Response('Not found', { status: 404 });
  }
}

const pkt = (line: string): string => `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, '0')}${line}`;

const advertise = (repository: FakeRepository): string => {
  const head = repository.branches.get('main')!;
  const lines = [
    `${head} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`,
    ...[...repository.branches].map(([branch, commit]) => `${commit} refs/heads/${branch}\n`),
    ...[...repository.tags].map(([tag, commit]) => `${commit} refs/tags/${tag}\n`),
  ];
  return `${pkt('# service=git-upload-pack\n')}0000${lines.map(pkt).join('')}0000`;
};

/** The tree under one top directory named after the repository, as Forgejo archives it. */
const tarball = (name: string, files: Files): ReadableStream<Uint8Array> => {
  const entries: TarStreamInput[] = [{ type: 'directory', path: `${name}/` }];
  for (const [path, file] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(typeof file === 'string' ? file : file.text);
    entries.push({
      type: 'file',
      path: `${name}/${path}`,
      size: bytes.length,
      readable: ReadableStream.from([bytes]),
      options: { mode: typeof file === 'string' ? 0o644 : file.mode },
    });
  }
  return ReadableStream.from(entries).pipeThrough(new TarStream()).pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
};

/** A module's tree: its manifest and one bash command saying `says`. */
export const moduleFiles = (name: string, version: string, says: string, extra: Record<string, unknown> = {}): Files => ({
  'mod.json': JSON.stringify({ name, version, coreApi: `^${MODULE_API_VERSION}`, ...extra }),
  [`bin/${name}`]: { text: `#!bash\necho "${says}"\n`, mode: 0o755 },
});
