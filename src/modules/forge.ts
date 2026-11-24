/**
 * Module repositories on a forge: what `mod install` and `mod search` read.
 *
 * The image has no git, so everything here is plain HTTP that GitHub, Forgejo and Gitea all
 * answer. A repository's branches and tags come from git's own advertisement over smart HTTP
 * (`<repository>.git/info/refs?service=git-upload-pack`), its tree at a commit is the forge's
 * `/archive/<commit>.tar.gz`, and an organisation's repositories, a file at a branch and the
 * commit a short id names come from the forge's API. A host is GitHub when it is `github.com`, and a Forgejo or a Gitea
 * otherwise.
 *
 * A module's code is fetched over https only: plain http, which a machine on the way could read and
 * change, is refused but for this machine (`localhost`, `127.0.0.1`, `::1`) and the hosts
 * `CFG_MODULE_SOURCES_INSECURE` names. A token is sent only to the origin it was given for
 * (`CFG_MODULE_SOURCES_KEY`, `host=token` for https), so an address typed on a command line cannot
 * take a token anywhere else, nor to its own host over http.
 */

import { compare, format, type SemVer, tryParse, tryParseRange } from '@std/semver';
import { inRange } from './version.ts';

/** The prefix a repository's name has when it holds a module: `module-archive` holds `archive`. */
export const MODULE_REPOSITORY_PREFIX = 'module-';

type ForgeKind = 'github' | 'gitea';

/** An organisation, or a user, whose `module-*` repositories are published modules. */
export type ModuleSource = {
  kind: ForgeKind;
  /** `https://github.com`, `https://forge.example:3000`. */
  origin: string;
  owner: string;
  /** `<origin>/<owner>`, as the setting names it. */
  url: string;
};

/** One repository. */
export type Repository = ModuleSource & {
  name: string;
  /** `<origin>/<owner>/<name>`: how an install records where it came from. */
  repository: string;
};

/** A repository as an organisation lists it. */
export type ListedRepository = Repository & {
  description: string;
  /** Its default branch. */
  branch: string;
};

/** The token for each origin, as `https://host[:port]`. */
export type Tokens = ReadonlyMap<string, string>;

/** The hosts, as `host[:port]`, whose sources and repositories may be reached over plain http. */
export type InsecureHosts = ReadonlySet<string>;

const NO_INSECURE_HOSTS: InsecureHosts = new Set();

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** Whether `url` may be fetched from: over https, or over http from this machine or a host named insecure. */
const reachable = (url: URL, insecure: InsecureHosts): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && (LOOPBACK.test(url.hostname) || insecure.has(url.host)));

/** What is wrong with `value` when it is an http address that is not `reachable`, else nothing. */
export const refusedHttp = (value: string, insecure: InsecureHosts): string | undefined => {
  const url = URL.parse(value);
  if (url?.protocol !== 'http:' || reachable(url, insecure)) return undefined;
  return `plain http, which anyone on the way can read and change, with the module's code and its token: use https, or name ${url.host} in CFG_MODULE_SOURCES_INSECURE: ${value}`;
};

/** A forge that does not answer as asked: the address, and what it said. */
export class ForgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ForgeError';
  }
}

const kindOf = (host: string): ForgeKind => host === 'github.com' || host === 'www.github.com' ? 'github' : 'gitea';

/** `https://host/owner` as a source, or nothing when it is not one, or is over http that `insecure` does not allow. */
export const parseSource = (value: string, insecure: InsecureHosts = NO_INSECURE_HOSTS): ModuleSource | undefined => {
  const url = URL.parse(value);
  if (!url || !reachable(url, insecure)) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || url.search || url.hash || url.username) return undefined;
  const origin = url.origin;
  return { kind: kindOf(url.host), origin, owner: parts[0], url: `${origin}/${parts[0]}` };
};

/**
 * `CFG_MODULE_SOURCES`, in order: addresses separated by spaces or commas. An entry that is no
 * organisation's address is a problem rather than a source.
 */
export const parseSources = (value: string, insecure: InsecureHosts = NO_INSECURE_HOSTS): { sources: ModuleSource[]; problems: string[] } => {
  const sources: ModuleSource[] = [];
  const problems: string[] = [];
  for (const entry of value.split(/[\s,]+/).filter(Boolean)) {
    const address = entry.replace(/\/+$/, '');
    const source = parseSource(address, insecure);
    if (source) sources.push(source);
    else problems.push(refusedHttp(address, insecure) ?? `not an organisation's address (https://host/owner): ${entry}`);
  }
  return { sources, problems };
};

/** `host[:port]` as an origin's host, as `URL` writes it: in lower case, without the scheme's own port. */
const hostOf = (scheme: 'http' | 'https', host: string): string | undefined => /^[^\s/@?#\\]+$/.test(host) ? URL.parse(`${scheme}://${host}`)?.host || undefined : undefined;

/**
 * `CFG_MODULE_SOURCES_KEY`: `host[:port]=token` for a host over https, or `http://host[:port]=token`
 * for one `CFG_MODULE_SOURCES_INSECURE` names, separated by spaces or commas; kept by origin.
 */
export const parseTokens = (value: string): Tokens => {
  const tokens = new Map<string, string>();
  for (const entry of value.split(/[\s,]+/).filter(Boolean)) {
    const at = entry.indexOf('=');
    if (at <= 0 || at === entry.length - 1) continue;
    const key = entry.slice(0, at);
    const http = /^http:\/\//i.test(key);
    const host = hostOf(http ? 'http' : 'https', key.replace(/^https?:\/\//i, ''));
    if (host) tokens.set(`${http ? 'http' : 'https'}://${host}`, entry.slice(at + 1));
  }
  return tokens;
};

/** `CFG_MODULE_SOURCES_INSECURE`: `host[:port]`, separated by spaces or commas. */
export const parseInsecureHosts = (value: string): InsecureHosts =>
  new Set(value.split(/[\s,]+/).filter(Boolean).map((entry) => hostOf('http', entry)).filter((host) => host !== undefined));

/** The repository `name` of a source. */
export const repositoryOf = (source: ModuleSource, name: string): Repository => ({
  ...source,
  name,
  repository: `${source.url}/${name}`,
});

/**
 * A repository's address, as a browser or `git clone` over HTTPS shows it: `https://host/owner/name`,
 * with or without `.git`; `git@github.com:owner/name.git` is taken as GitHub's HTTPS address.
 */
export const parseRepository = (value: string, insecure: InsecureHosts = NO_INSECURE_HOSTS): Repository | undefined => {
  const scp = /^git@([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
  const address = scp ? `https://${scp[1]}/${scp[2]}/${scp[3]}` : value;
  const url = URL.parse(address);
  if (!url || !reachable(url, insecure)) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || url.search || url.hash || url.username) return undefined;
  const source = parseSource(`${url.origin}/${parts[0]}`, insecure);
  return source && repositoryOf(source, parts[1].replace(/\.git$/, ''));
};

/** What `mod install` was asked for: a repository's address, or a published module's name, each perhaps with a ref. */
export type InstallTarget =
  | { kind: 'repository'; repository: Repository; ref?: string }
  | { kind: 'name'; name: string; ref?: string };

/** A module's name: what its directory under the modules is called. */
export const MODULE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * `https://host/owner/module-x[@ref]` or `x[@ref]`. The ref follows the last `@` after the path's
 * last `/`, so a user name in the address is not taken for one.
 */
export const parseInstallTarget = (value: string, insecure: InsecureHosts = NO_INSECURE_HOSTS): InstallTarget | { error: string } => {
  const isAddress = value.includes('://') || value.startsWith('git@');
  const slash = value.lastIndexOf('/');
  const at = value.lastIndexOf('@');
  const [body, ref] = at > slash && at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, undefined];
  if (ref === '') return { error: `no ref after '@': ${value}` };
  if (!isAddress) {
    return MODULE_NAME.test(body) ? { kind: 'name', name: body, ref } : { error: `not a module's name or a repository's address: ${value}` };
  }
  const repository = parseRepository(body, insecure);
  if (repository) return { kind: 'repository', repository, ref };
  return { error: refusedHttp(body, insecure) ?? `not a repository's address (https://host/owner/name): ${body}` };
};

/** The module a repository is expected to hold, by its name: `module-archive` holds `archive`. */
export const moduleNameOf = (repository: Repository): string =>
  repository.name.startsWith(MODULE_REPOSITORY_PREFIX) ? repository.name.slice(MODULE_REPOSITORY_PREFIX.length) : repository.name;

const tokenFor = (source: ModuleSource, tokens: Tokens): string | undefined => tokens.get(source.origin);

/** What a request to the forge carries: its token, in the form that kind of request takes there. */
const authorization = (source: ModuleSource, tokens: Tokens, to: 'git' | 'api'): Record<string, string> => {
  const token = tokenFor(source, tokens);
  if (!token) return {};
  if (source.kind === 'gitea') return { Authorization: `token ${token}` };
  return to === 'git' ? { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } : { Authorization: `Bearer ${token}` };
};

const apiOrigin = (source: ModuleSource): string => source.kind === 'github' ? 'https://api.github.com' : `${source.origin}/api/v1`;

/** The response to a GET, or a `ForgeError` saying what the address answered. */
const get = async (url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ForgeError(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 401 || response.status === 403 || response.status === 404 ? ', or it needs a token (CFG_MODULE_SOURCES_KEY)' : '';
    throw new ForgeError(`${url}: ${response.status} ${response.statusText || 'error'}${response.status === 404 ? ': not found' : ''}${hint}`, response.status);
  }
  return response;
};

/** The pkt-lines of a smart HTTP answer, as text, with the flush packets left out. */
const parsePktLines = (body: Uint8Array): string[] => {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const length = parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (Number.isNaN(length)) throw new ForgeError('not a git smart HTTP answer');
    if (length === 0) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) throw new ForgeError('a truncated git smart HTTP answer');
    lines.push(decoder.decode(body.subarray(at + 4, at + length)).replace(/\n$/, ''));
    at += length;
  }
  return lines;
};

/** A repository's branches and tags: each ref's commit, and which branch is the default one. */
export type Refs = {
  /** The default branch's commit. */
  head?: string;
  /** The default branch: `main`. */
  branch?: string;
  /** `refs/heads/main`, `refs/tags/v1.0.0`, and for an annotated tag `refs/tags/v1.0.0^{}`, its commit. */
  refs: ReadonlyMap<string, string>;
};

/** The ref advertisement git's `upload-pack` answers with. */
export const parseRefAdvertisement = (body: Uint8Array): Refs => {
  const lines = parsePktLines(body);
  if (lines[0]?.startsWith('# service=')) lines.shift();
  const refs = new Map<string, string>();
  let head: string | undefined;
  let branch: string | undefined;
  for (const [index, line] of lines.entries()) {
    const [ref, capabilities] = line.split('\0');
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(ref);
    if (!match) continue;
    const [, commit, name] = match;
    if (index === 0 && capabilities) branch = /(?:^| )symref=HEAD:refs\/heads\/(\S+)/.exec(capabilities)?.[1];
    if (name === 'HEAD') head = commit;
    else refs.set(name, commit);
  }
  return { head, branch, refs };
};

/** A repository's refs, as git's smart HTTP advertises them. */
export const fetchRefs = async (repository: Repository, tokens: Tokens, signal?: AbortSignal): Promise<Refs> => {
  const url = `${repository.repository}.git/info/refs?service=git-upload-pack`;
  const response = await get(url, authorization(repository, tokens, 'git'), signal);
  return parseRefAdvertisement(new Uint8Array(await response.arrayBuffer()));
};

const COMMIT = /^[0-9a-f]{40}$/;

/** A release: a `v<version>` tag, as a module's release is tagged. */
type Release = { tag: string; version: string; commit: string };

/**
 * The repository's releases, newest first; a tag that is no version is none, and a prerelease
 * (`v0.6.0-dev.3`) only with `prereleases`.
 */
export const releases = (refs: Refs, prereleases = false): Release[] => {
  const found: (Release & { parsed: SemVer })[] = [];
  for (const [name, commit] of refs.refs) {
    const tag = /^refs\/tags\/(v[^^]+)$/.exec(name)?.[1];
    const parsed = tag ? tryParse(tag.slice(1)) : undefined;
    if (!tag || !parsed || (parsed.prerelease?.length && !prereleases)) continue;
    found.push({ tag, version: format(parsed), commit: refs.refs.get(`${name}^{}`) ?? commit, parsed });
  }
  return found.sort((a, b) => compare(b.parsed, a.parsed)).map(({ tag, version, commit }) => ({ tag, version, commit }));
};

/** Whether `version` is in `range`, as `inRange` has it; a version or range that does not parse takes none. */
const accepts = (version: string, range: string): boolean => {
  const [parsed, parsedRange] = [tryParse(version), tryParseRange(range)];
  return parsed !== undefined && parsedRange !== undefined && inRange(parsed, parsedRange);
};

/** What may be a commit id cut short, as git takes one: four hex digits or more. */
export const ABBREVIATED_COMMIT = /^[0-9a-f]{4,39}$/;

/**
 * The commit `ref` names — a branch, a tag or a whole commit id — or the default branch's when it
 * is `HEAD`; nothing when the advertisement has no such ref. A tag wins over a branch of the same
 * name, as in git. A commit id cut short is not advertised: `fetchCommit` finds it.
 *
 * Without a ref it is the newest release, a prerelease too with `prereleases`, and the default
 * branch's commit when there is none; with `range`, the newest release in it, and else as without one.
 */
export const resolveRef = (refs: Refs, ref?: string, range?: string, prereleases = false): { ref: string; commit: string } | undefined => {
  if (ref === undefined) {
    const all = releases(refs, prereleases);
    const newest = (range === undefined ? undefined : all.find((release) => accepts(release.version, range))) ?? all[0];
    if (newest) return { ref: newest.tag, commit: newest.commit };
  }
  if (ref === undefined || ref === 'HEAD') return refs.head ? { ref: refs.branch ?? 'HEAD', commit: refs.head } : undefined;
  if (COMMIT.test(ref)) return { ref, commit: ref };
  for (const name of [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ...(ref.startsWith('refs/') ? [ref] : [])]) {
    const commit = refs.refs.get(name);
    if (commit) return { ref, commit };
  }
  return undefined;
};

/** The whole id of the commit `id` begins, from the forge's API; nothing when no single commit does. */
export const fetchCommit = async (repository: Repository, id: string, tokens: Tokens, signal?: AbortSignal): Promise<string | undefined> => {
  const url = repository.kind === 'github'
    ? `${apiOrigin(repository)}/repos/${repository.owner}/${repository.name}/commits/${id}`
    : `${apiOrigin(repository)}/repos/${repository.owner}/${repository.name}/git/commits/${id}?stat=false&verification=false&files=false`;
  const headers = { ...authorization(repository, tokens, 'api'), ...(repository.kind === 'github' ? { Accept: 'application/vnd.github+json' } : {}) };
  try {
    const sha = (await (await get(url, headers, signal)).json() as { sha?: unknown }).sha;
    return typeof sha === 'string' && COMMIT.test(sha) && sha.startsWith(id) ? sha : undefined;
  } catch (error) {
    // GitHub answers 422 for an id no commit begins, or more than one does.
    if (error instanceof ForgeError && (error.status === 404 || error.status === 422)) return undefined;
    throw error;
  }
};

/** The repository's tree at `commit`, as a gzipped tar whose entries sit under one top directory. */
export const fetchArchive = async (repository: Repository, commit: string, tokens: Tokens, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
  // github.com's own archive address takes no token; its API's does, for a private repository.
  const url = repository.kind === 'github' && tokenFor(repository, tokens)
    ? `${apiOrigin(repository)}/repos/${repository.owner}/${repository.name}/tarball/${commit}`
    : `${repository.repository}/archive/${commit}.tar.gz`;
  const response = await get(url, authorization(repository, tokens, 'api'), signal);
  if (!response.body) throw new ForgeError(`${url}: an empty answer`);
  return response.body;
};

/** A file of the repository at `ref`, as text; nothing when it has no such file. */
export const fetchFile = async (repository: Repository, ref: string, path: string, tokens: Tokens, signal?: AbortSignal): Promise<string | undefined> => {
  const url = repository.kind === 'github' && !tokenFor(repository, tokens)
    ? `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/${encodeURIComponent(ref)}/${path}`
    : `${apiOrigin(repository)}/repos/${repository.owner}/${repository.name}/${repository.kind === 'github' ? 'contents' : 'raw'}/${path}?ref=${encodeURIComponent(ref)}`;
  const headers = { ...authorization(repository, tokens, 'api'), ...(repository.kind === 'github' ? { Accept: 'application/vnd.github.raw+json' } : {}) };
  try {
    return await (await get(url, headers, signal)).text();
  } catch (error) {
    if (error instanceof ForgeError && error.status === 404) return undefined;
    throw error;
  }
};

/**
 * The first of `candidates`, newest first, whose `mod.json` at its tag `accept` takes, with that
 * manifest; nothing when none does. Each release passed over costs a request; one without a
 * `mod.json` that parses is passed over.
 */
export const findRelease = async <M>(
  repository: Repository,
  candidates: readonly Release[],
  tokens: Tokens,
  accept: (manifest: M) => boolean,
  signal?: AbortSignal,
): Promise<{ release: Release; manifest: M } | undefined> => {
  for (const release of candidates) {
    const text = await fetchFile(repository, release.tag, 'mod.json', tokens, signal);
    let manifest: M;
    try {
      manifest = JSON.parse(text ?? '');
    } catch {
      continue;
    }
    if (manifest && typeof manifest === 'object' && accept(manifest)) return { release, manifest };
  }
  return undefined;
};

type ApiRepository = { name: string; description?: string | null; default_branch?: string; archived?: boolean; empty?: boolean };

/** Pages a forge's repository listing gives at most. */
const MAX_PAGES = 10;

/**
 * The source's `module-*` repositories, by name, archived ones left out. An organisation's list is
 * asked for first and a user's after it, since a source may be either.
 */
export const listModuleRepositories = async (source: ModuleSource, tokens: Tokens, signal?: AbortSignal): Promise<ListedRepository[]> => {
  const headers = { ...authorization(source, tokens, 'api'), ...(source.kind === 'github' ? { Accept: 'application/vnd.github+json' } : {}) };
  const size = source.kind === 'github' ? 100 : 50;
  const pageOf = (kind: 'orgs' | 'users', page: number) =>
    `${apiOrigin(source)}/${kind}/${source.owner}/repos?${source.kind === 'github' ? `per_page=${size}&type=all` : `limit=${size}`}&page=${page}`;

  const listed: ApiRepository[] = [];
  let kind: 'orgs' | 'users' = 'orgs';
  for (let page = 1; page <= MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await get(pageOf(kind, page), headers, signal);
    } catch (error) {
      if (kind === 'orgs' && page === 1 && error instanceof ForgeError && error.status === 404) {
        kind = 'users';
        page = 0;
        continue;
      }
      throw error;
    }
    const batch = await response.json() as ApiRepository[];
    if (!Array.isArray(batch)) throw new ForgeError(`${pageOf(kind, page)}: not a list of repositories`);
    listed.push(...batch);
    if (batch.length < size) break;
  }

  return listed
    .filter((entry) => entry.name.startsWith(MODULE_REPOSITORY_PREFIX) && entry.name.length > MODULE_REPOSITORY_PREFIX.length && !entry.archived && !entry.empty)
    .map((entry) => ({ ...repositoryOf(source, entry.name), description: entry.description ?? '', branch: entry.default_branch || 'main' }))
    .sort((a, b) => a.name.localeCompare(b.name));
};
