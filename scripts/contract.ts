/**
 * The module contract's surface, as a snapshot a test can compare: every symbol `@ein/client`,
 * `@ein/api`, `@ein/paths` and the shell's kit (`@ein/ui/*`) export, with a hash of its declaration.
 *
 * `MODULE_API_VERSION` (src/modules/types.ts) is only a promise if something notices when the
 * surface moves. The hash is of `deno doc --json`'s declaration with its doc comment and source
 * position removed, so rewording a comment or moving a line changes nothing, while a changed
 * parameter, field or return type does.
 *
 *   deno task contract:snapshot   # after bumping MODULE_API_VERSION, rewrite the snapshot
 */

import { MODULE_API_VERSION } from '../src/modules/types.ts';

export const CONTRACT_ENTRIES = [
  'src/client/mod.ts',
  'src/lib/api/mod.ts',
  'src/lib/paths.ts',
  // The kit the shell lends a module's pages as `@ein/ui/*` (`src/builtin/ui/lib/shared.ts`), so a
  // page's `coreApi` range covers it too.
  'src/builtin/ui/src/client/components/mod.ts',
  'src/builtin/ui/src/client/hooks/mod.ts',
  'src/builtin/ui/src/client/lib/mod.ts',
  'src/builtin/ui/src/client/signals/mod.ts',
  'src/builtin/ui/src/client/theme/mod.ts',
];
export const SNAPSHOT = new URL('../src/client/contract.snapshot', import.meta.url);

/** The declaration without what does not change its meaning: where it is, and what it says about itself. */
const strip = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'location' || key === 'jsDoc' || key === 'byteIndex' || key === 'filename') continue;
      out[key] = strip((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

const hash = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

type Member = { name: string };
type ObjectType = { properties?: Member[]; methods?: Member[]; callSignatures?: unknown[]; indexSignatures?: unknown[]; constructors?: unknown[] };
type Param = { kind?: string; props?: { key?: string }[] };
type Declaration = {
  kind?: string;
  def?: ObjectType & { typeParams?: unknown[]; tsType?: { kind?: string; value?: ObjectType }; params?: Param[] };
};

/**
 * A function whose one parameter is a destructured object, as every kit component is: each
 * destructured name is a member, and everything else in the declaration (the parameter's type, the
 * return type, type parameters) is the member `@signature`. A component that only gained a prop
 * then counts as extended, while a changed return or parameter type still counts as changed.
 */
const propMembers = async (declaration: Declaration): Promise<string | undefined> => {
  const params = declaration.kind === 'function' ? declaration.def?.params : undefined;
  if (params?.length !== 1 || params[0].kind !== 'object' || !params[0].props) return undefined;
  const props = params[0].props;
  if (props.some((prop) => typeof prop.key !== 'string')) return undefined;
  const signature = { ...declaration, def: { ...declaration.def, params: [{ ...params[0], props: [] }] } };
  const hashed = await Promise.all(props.map(async (prop) => `${prop.key}=${await hash(JSON.stringify(strip(prop)))}`));
  return [...hashed, `@signature=${await hash(JSON.stringify(strip(signature)))}`].sort().join(',');
};

/**
 * The members of an interface, or of a type that is a plain object type (`type X = { … }`, as
 * every answer in `@ein/api` is), each hashed: what lets the test tell a type that only gained a
 * member — a compatible change, nothing a module used is gone — from one that changed or lost one. An
 * object type with type parameters or signatures has none, since those could change while every
 * member stays.
 */
const memberHashes = async (declarations: Declaration[]): Promise<string | undefined> => {
  const [declaration] = declarations;
  if (declarations.length === 1) {
    const props = await propMembers(declaration);
    if (props) return props;
  }
  const literal = declaration?.kind === 'typeAlias' && declaration.def?.tsType?.kind === 'typeLiteral' && !declaration.def.typeParams?.length
    ? declaration.def.tsType.value
    : undefined;
  const def = declarations.length !== 1
    ? undefined
    : declaration.kind === 'interface'
    ? declaration.def
    : literal && !literal.callSignatures?.length && !literal.indexSignatures?.length && !literal.constructors?.length
    ? literal
    : undefined;
  if (!def) return undefined;
  const members = [...(def.properties ?? []), ...(def.methods ?? [])];
  const hashed = await Promise.all(members.map(async (member) => `${member.name}=${await hash(JSON.stringify(strip(member)))}`));
  return hashed.sort().join(',');
};

/** `<entry> <symbol> <hash> [<member>=<hash>,…]` per exported symbol, sorted; members for an interface, an object type or a function of one destructured object. */
export const contractSurface = async (): Promise<string[]> => {
  const root = new URL('..', import.meta.url).pathname;
  const lines: string[] = [];
  for (const entry of CONTRACT_ENTRIES) {
    const out = await new Deno.Command(Deno.execPath(), { args: ['doc', '--json', entry], cwd: root, stdout: 'piped', stderr: 'piped' }).output();
    if (!out.success) throw new Error(`deno doc ${entry}: ${new TextDecoder().decode(out.stderr)}`);
    const doc = JSON.parse(new TextDecoder().decode(out.stdout)) as { nodes: Record<string, { symbols: { name: string; declarations: unknown[] }[] }> };
    for (const file of Object.values(doc.nodes)) {
      for (const symbol of file.symbols) {
        const members = await memberHashes(symbol.declarations as Declaration[]);
        lines.push(`${entry} ${symbol.name} ${await hash(JSON.stringify(strip(symbol.declarations)))}${members ? ` ${members}` : ''}`);
      }
    }
  }
  return lines.sort();
};

/** The snapshot as written: the version it describes, then the surface. */
export const readSnapshot = async (): Promise<{ version: string; lines: string[] }> => {
  const [header, ...lines] = (await Deno.readTextFile(SNAPSHOT)).trim().split('\n');
  return { version: header.replace(/^MODULE_API_VERSION /, ''), lines };
};

if (import.meta.main) {
  const lines = await contractSurface();
  await Deno.writeTextFile(SNAPSHOT, [`MODULE_API_VERSION ${MODULE_API_VERSION}`, ...lines].join('\n') + '\n');
  console.log(`wrote ${SNAPSHOT.pathname}: ${lines.length} symbols at ${MODULE_API_VERSION}`);
}
