/**
 * A small SSH server for tests of EiN's outbound SSH (`ssh`, `scp`,
 * `ssh-copy-id`, the sftp mount): public-key auth with real signature checks
 * (keys read from `<root>/.ssh/authorized_keys` on every attempt, as sshd
 * does), an optional password, `exec` answered by a callback, and an SFTP
 * subsystem serving a host directory. Paths are relative to that directory,
 * which is also the "home" a relative path starts from.
 *
 * Not a sandbox: absolute paths are taken as given below `root`, and `..` is
 * refused, which is enough for tests that write inside a temp directory.
 */

import { join, normalize } from '@std/path';
import {
  type Connection,
  generateKeyPair,
  OPEN_MODE,
  type ParsedKey,
  parseKey,
  type PKAuthContext,
  type PwdAuthContext,
  Server,
  type ServerAuthContext,
  type Session,
  SFTP,
  STATUS_CODE,
} from 'ssh2';

export interface ExecResult {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface SshTestServerOptions {
  /** Directory served over SFTP; its `.ssh/authorized_keys` decides key auth */
  root: string;
  /** Accept this password for any user */
  password?: string;
  /** Answer an exec request; default: echo the command back, exit 0 */
  exec?: (command: string, stdin: string) => ExecResult | Promise<ExecResult>;
}

export interface SshTestServer {
  port: number;
  /** The server's host key blob, e.g. to pin or to write into known_hosts */
  hostKey: Uint8Array;
  /** Methods tried per connection, in order, e.g. ['none', 'publickey', 'password'] */
  authLog: string[];
  close(): Promise<void>;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function attrsOf(info: Deno.FileInfo) {
  const type = info.isSymlink ? S_IFLNK : info.isDirectory ? S_IFDIR : S_IFREG;
  return {
    mode: type | ((info.mode ?? 0o644) & 0o7777),
    uid: info.uid ?? 0,
    gid: info.gid ?? 0,
    size: info.size,
    atime: Math.floor((info.atime?.getTime() ?? Date.now()) / 1000),
    mtime: Math.floor((info.mtime?.getTime() ?? Date.now()) / 1000),
  };
}

function statusFor(err: unknown): number {
  if (err instanceof Deno.errors.NotFound) return STATUS_CODE.NO_SUCH_FILE;
  if (err instanceof Deno.errors.PermissionDenied) return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

async function authorizedKeys(root: string): Promise<ParsedKey[]> {
  let text = '';
  try {
    text = await Deno.readTextFile(join(root, '.ssh', 'authorized_keys'));
  } catch {
    return [];
  }
  const keys: ParsedKey[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseKey(line.trim());
    if (!(parsed instanceof Error)) keys.push(Array.isArray(parsed) ? parsed[0] : parsed);
  }
  return keys;
}

/** The first `count` SSH strings (uint32 length, bytes) of a request's data */
function sshStrings(data: Uint8Array, count: number): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: string[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(p);
    out.push(new TextDecoder().decode(data.subarray(p + 4, p + 4 + len)));
    p += 4 + len;
  }
  return out;
}

/** An SFTP server over a host directory, enough for the client operations EiN uses */
function serveSftp(sftp: SFTP, root: string) {
  const resolvePath = (path: string) => {
    const rel = normalize(path.startsWith('/') ? path.slice(1) : path);
    if (rel.startsWith('..')) throw new Deno.errors.PermissionDenied(path);
    return join(root, rel);
  };

  const files = new Map<number, Deno.FsFile>();
  const dirs = new Map<number, { entries?: Deno.DirEntry[]; path: string }>();
  let nextHandle = 1;
  const handleBuf = (n: number) => new TextEncoder().encode(String(n));
  const handleNum = (buf: Uint8Array) => Number(new TextDecoder().decode(buf));

  // Seek-then-read on one file is not atomic: requests on a handle run one at a
  // time, as a server with positional reads would answer them
  const queues = new Map<number, Promise<void>>();
  const serial = (handle: Uint8Array, fn: () => Promise<void>) => {
    const n = handleNum(handle);
    const next = (queues.get(n) ?? Promise.resolve()).then(fn);
    queues.set(n, next);
    return next;
  };

  const reply = async (reqid: number, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      sftp.status(reqid, statusFor(err), (err as Error).message);
    }
  };

  sftp.on('OPEN', (reqid: number, filename: string, flags: number) =>
    reply(reqid, async () => {
      const file = await Deno.open(resolvePath(filename), {
        read: !!(flags & OPEN_MODE.READ),
        write: !!(flags & OPEN_MODE.WRITE) && !(flags & OPEN_MODE.APPEND),
        append: !!(flags & OPEN_MODE.APPEND),
        create: !!(flags & OPEN_MODE.CREAT),
        truncate: !!(flags & OPEN_MODE.TRUNC),
        createNew: !!(flags & OPEN_MODE.EXCL),
      });
      const n = nextHandle++;
      files.set(n, file);
      sftp.handle(reqid, handleBuf(n));
    }));

  sftp.on('READ', (reqid: number, handle: Uint8Array, offset: number, length: number) =>
    serial(handle, () =>
      reply(reqid, async () => {
        const file = files.get(handleNum(handle));
        if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle');
        await file.seek(offset, Deno.SeekMode.Start);
        const buf = new Uint8Array(length);
        const n = await file.read(buf);
        if (n === null || n === 0) sftp.status(reqid, STATUS_CODE.EOF);
        else sftp.data(reqid, buf.subarray(0, n));
      })));

  sftp.on('WRITE', (reqid: number, handle: Uint8Array, offset: number, data: Uint8Array) =>
    serial(handle, () =>
      reply(reqid, async () => {
        const file = files.get(handleNum(handle));
        if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle');
        await file.seek(offset, Deno.SeekMode.Start);
        let written = 0;
        while (written < data.length) written += await file.write(data.subarray(written));
        sftp.status(reqid, STATUS_CODE.OK);
      })));

  sftp.on('CLOSE', (reqid: number, handle: Uint8Array) =>
    serial(handle, async () => {
      const n = handleNum(handle);
      files.get(n)?.close();
      files.delete(n);
      dirs.delete(n);
      queues.delete(n);
      sftp.status(reqid, STATUS_CODE.OK);
    }));

  sftp.on('FSTAT', (reqid: number, handle: Uint8Array) =>
    reply(reqid, async () => {
      const file = files.get(handleNum(handle));
      if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle');
      sftp.attrs(reqid, attrsOf(await file.stat()));
    }));

  sftp.on('STAT', (reqid: number, path: string) => reply(reqid, async () => sftp.attrs(reqid, attrsOf(await Deno.stat(resolvePath(path))))));
  sftp.on('LSTAT', (reqid: number, path: string) => reply(reqid, async () => sftp.attrs(reqid, attrsOf(await Deno.lstat(resolvePath(path))))));

  sftp.on('OPENDIR', (reqid: number, path: string) =>
    reply(reqid, async () => {
      const abs = resolvePath(path);
      if (!(await Deno.stat(abs)).isDirectory) throw new Error('not a directory');
      const n = nextHandle++;
      dirs.set(n, { path: abs });
      sftp.handle(reqid, handleBuf(n));
    }));

  sftp.on('READDIR', (reqid: number, handle: Uint8Array) =>
    reply(reqid, async () => {
      const dir = dirs.get(handleNum(handle));
      if (!dir) return sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle');
      if (dir.entries) return sftp.status(reqid, STATUS_CODE.EOF);
      dir.entries = await Array.fromAsync(Deno.readDir(dir.path));
      if (!dir.entries.length) return sftp.status(reqid, STATUS_CODE.EOF);
      const names = [];
      for (const e of dir.entries) {
        const attrs = attrsOf(await Deno.lstat(join(dir.path, e.name)));
        names.push({ filename: e.name, longname: e.name, attrs });
      }
      sftp.name(reqid, names);
    }));

  sftp.on('MKDIR', (reqid: number, path: string, attrs: { mode?: number }) =>
    reply(reqid, async () => {
      await Deno.mkdir(resolvePath(path), { mode: attrs?.mode ?? 0o755 });
      sftp.status(reqid, STATUS_CODE.OK);
    }));
  sftp.on('RMDIR', (reqid: number, path: string) =>
    reply(reqid, async () => {
      await Deno.remove(resolvePath(path));
      sftp.status(reqid, STATUS_CODE.OK);
    }));
  sftp.on('REMOVE', (reqid: number, path: string) =>
    reply(reqid, async () => {
      await Deno.remove(resolvePath(path));
      sftp.status(reqid, STATUS_CODE.OK);
    }));
  sftp.on('RENAME', (reqid: number, from: string, to: string) =>
    reply(reqid, async () => {
      // SFTP v3 RENAME fails when the target exists, unlike rename(2)
      const exists = await Deno.lstat(resolvePath(to)).then(() => true, () => false);
      if (exists) return sftp.status(reqid, STATUS_CODE.FAILURE, 'target exists');
      await Deno.rename(resolvePath(from), resolvePath(to));
      sftp.status(reqid, STATUS_CODE.OK);
    }));
  sftp.on('EXTENDED', (reqid: number, name: string, data: Uint8Array) =>
    reply(reqid, async () => {
      if (name !== 'posix-rename@openssh.com') return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
      const [from, to] = sshStrings(data, 2);
      await Deno.rename(resolvePath(from), resolvePath(to));
      sftp.status(reqid, STATUS_CODE.OK);
    }));
  sftp.on('SETSTAT', (reqid: number, path: string, attrs: { mode?: number; atime?: number; mtime?: number }) =>
    reply(reqid, async () => {
      const abs = resolvePath(path);
      if (attrs.mode !== undefined) await Deno.chmod(abs, attrs.mode & 0o7777);
      if (attrs.mtime !== undefined) await Deno.utime(abs, attrs.atime ?? attrs.mtime, attrs.mtime);
      sftp.status(reqid, STATUS_CODE.OK);
    }));
  sftp.on('REALPATH', (reqid: number, path: string) =>
    reply(reqid, async () => {
      const rel = normalize(path === '.' ? '/' : path.startsWith('/') ? path : `/${path}`);
      sftp.name(reqid, [{ filename: rel, longname: rel, attrs: {} }]);
    }));
  sftp.on('READLINK', (reqid: number, path: string) =>
    reply(reqid, async () => {
      const target = await Deno.readLink(resolvePath(path));
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]);
    }));
  // ssh2-ts emits the link path first, whichever order the client sent
  sftp.on('SYMLINK', (reqid: number, linkPath: string, targetPath: string) =>
    reply(reqid, async () => {
      await Deno.symlink(targetPath, resolvePath(linkPath));
      sftp.status(reqid, STATUS_CODE.OK);
    }));
}

export async function startSshTestServer(opts: SshTestServerOptions): Promise<SshTestServer> {
  const hostPair = await generateKeyPair('ed25519');
  const hostKey = parseKey(hostPair.private) as ParsedKey;
  const server = new Server({ hostKeys: [hostKey] });
  const authLog: string[] = [];
  const connections = new Set<Connection>();

  server.on('connection', (conn: Connection) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    conn.on('error', () => {});

    conn.on('authentication', (ctx: ServerAuthContext) => {
      authLog.push(ctx.method);
      const methods = opts.password ? ['publickey', 'password'] : ['publickey'];

      if (ctx.method === 'password' && opts.password && (ctx as PwdAuthContext).password === opts.password) {
        return ctx.accept();
      }
      if (ctx.method === 'publickey') {
        const pk = ctx as PKAuthContext;
        (async () => {
          const keys = await authorizedKeys(opts.root);
          const key = keys.find((k) => {
            const blob = k.getPublicSSH();
            return blob && blob.length === pk.key.data.length && blob.every((b, i) => b === pk.key.data[i]);
          });
          if (!key) return ctx.reject(methods);
          if (!pk.signature) return ctx.accept(); // the query: PK_OK
          const ok = await key.verify(pk.blob!, pk.signature, pk.hashAlgo);
          if (ok === true) ctx.accept();
          else ctx.reject(methods);
        })();
        return;
      }
      ctx.reject(methods);
    });

    conn.on('ready', () => {
      conn.on('session', (accept: () => Session | undefined) => {
        const session = accept();
        if (!session) return;

        session.on('exec', async (acceptExec, _reject, info) => {
          const channel = acceptExec();
          if (!channel) return;
          const result = await (opts.exec?.(info.command, '') ?? { stdout: `${info.command}\n`, code: 0 });
          if (result.stdout) channel.write(result.stdout);
          if (result.stderr) (channel.stderr as { write(data: string): void }).write(result.stderr);
          channel.exit(result.code ?? 0);
          channel.end();
        });

        session.on('sftp', (acceptSftp) => {
          const channel = acceptSftp();
          if (!channel) return;
          const sftp = new SFTP(
            { protocol: conn.protocol },
            { type: 'session', incoming: channel.incoming, outgoing: channel.outgoing },
            { server: true, extensions: { 'posix-rename@openssh.com': '1' } },
          );
          (async () => {
            try {
              for await (const chunk of channel.readable) sftp.push(chunk);
            } catch {
              // connection went away
            }
            sftp.push(null);
            channel.end();
          })();
          serveSftp(sftp, opts.root);
        });
      });
    });
  });

  await server.listen(0, '127.0.0.1');
  const port = server.address()!.port;

  return {
    port,
    hostKey: hostKey.getPublicSSH()!,
    authLog,
    async close() {
      for (const conn of connections) conn.end();
      server.close();
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}
