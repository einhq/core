import { parseArgs } from '../../../../lib/args/mod.ts';
import { basename, dirname, resolve } from '@std/path';
import { chmodToMode } from '../../../../lib/mode/mod.ts';
import { NodePropsCreate } from '../../../../vfs/mod.ts';
import type { FileTier } from '../../../../registries/file/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const FILE_TIERS: FileTier[] = ['disk', 'volatile', 'db'];

export const mknode = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['p'],
    string: ['t', 'm', 'o', 'g', 'under', 'tier'],
    collect: ['as', 'an', 'aj', 'al'],
    alias: {
      t: 'type',
      m: 'mode',
      o: 'owner',
      g: 'group',
      as: 'attr-string',
      an: 'attr-number',
      aj: 'attr-json',
      al: 'attr-list',
    },
  });
  // Every operand is a node to create; `mkdir` is `mknode -t directory "$@"`.
  const flagsPaths = flags._.map((operand) => String(operand));
  const flagsType = flags.t;
  const flagsMode = flags.m;
  const flagsOwner = flags.o;
  const flagsGroup = flags.g;
  const flagsUnder = flags.under as string | undefined;
  const flagsTier = flags.tier as string | undefined;
  const flagsAttrsS = flags.as as string[];
  const flagsAttrsN = flags.an as string[];
  const flagsAttrsJ = flags.aj as string[];
  const flagsAttrsL = flags.al as string[];
  const ensure = flags.p;

  if (flagsPaths.length === 0) {
    await cmd.writeError('mknode: missing path\n');
    return 1;
  }

  if (!flagsType) {
    await cmd.writeError('mknode: missing type\n');
    return 1;
  }

  // The flags describe *what* to create, so they are parsed once and applied to
  // every operand. Owner and group in particular cost a `user-resolve` subshell
  // each; resolving them per operand would multiply that by the operand count.
  const attrs: Record<string, any> = {};
  const props: Partial<NodePropsCreate> = {};

  try {
    if (flagsTier !== undefined) {
      if (!FILE_TIERS.includes(flagsTier as FileTier)) {
        throw new Error(`invalid tier '${flagsTier}', expected ${FILE_TIERS.join(', ')}`);
      }
      props.tier = flagsTier as FileTier;
    }

    if (flagsAttrsS?.length > 0) {
      for (const s of flagsAttrsS) {
        const [key, ...rest] = s.split('=');
        const value = rest.join('=');

        value && (attrs[key] = value);
      }
    }

    if (flagsAttrsN?.length > 0) {
      for (const s of flagsAttrsN) {
        const [key, ...rest] = s.split('=');
        const strValue = rest.join('=');

        if (strValue) {
          const value = Number.parseFloat(strValue);

          if (Number.isNaN(value)) {
            throw new Error(`attribute '${key}' value is not a number '${strValue}'`);
          }

          attrs[key] = value;
        }
      }
    }

    if (flagsAttrsJ?.length > 0) {
      for (const s of flagsAttrsJ) {
        const [key, ...rest] = s.split('=');
        const strValue = rest.join('=');

        try {
          attrs[key] = JSON.parse(strValue);
        } catch (err) {
          throw new Error(`attribute '${key}' value is not valid json '${strValue}', ${(err as Error).message}`);
        }
      }
    }

    // A list attribute is comma-separated.
    if (flagsAttrsL?.length > 0) {
      for (const s of flagsAttrsL) {
        const [key, ...rest] = s.split('=');
        const strValue = rest.join('=');

        if (strValue) {
          attrs[key] = strValue.split(',').map((v) => v.trim());
        }
      }
    }

    // The tier routes a file's bytes only as a prop; as an attr it is ignored and the bytes
    // land on the default tier.
    if ('tier' in attrs) {
      throw new Error('tier is not an attribute; use --tier');
    }

    if (flagsMode) {
      try {
        props.mode = chmodToMode(flagsMode);
      } catch {
        throw new Error(`invalid mode '${flagsMode}'`);
      }
    }

    if (flagsOwner) {
      const asNumber = Number.parseInt(flagsOwner, 10);
      const isNumeric = !Number.isNaN(asNumber) && String(asNumber) === flagsOwner;

      if (isNumeric) {
        props.uid = asNumber;
      } else {
        const { code, stdout } = await cmd.execute(`user-resolve ${flagsOwner}`);

        if (code !== 0) {
          throw new Error(`could not resolve owner '${flagsOwner}'`);
        }

        props.uid = Number.parseInt(stdout.replace(/\n+$/, ''), 10);

        if (Number.isNaN(props.uid)) {
          throw new Error(`could not resolve valid owner '${flagsOwner}'`);
        }
      }
    }

    if (flagsGroup) {
      const asNumber = Number.parseInt(flagsGroup, 10);
      const isNumeric = !Number.isNaN(asNumber) && String(asNumber) === flagsGroup;

      if (isNumeric) {
        props.gid = asNumber;
      } else {
        const { code, stdout } = await cmd.execute(`group-resolve ${flagsGroup}`);

        if (code !== 0) {
          throw new Error(`could not resolve group '${flagsGroup}'`);
        }

        props.gid = Number.parseInt(stdout.replace(/\n+$/, ''), 10);

        if (Number.isNaN(props.gid)) {
          throw new Error(`could not resolve valid group '${flagsGroup}'`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`mknode: ${message}\n`);

    return 1;
  }

  // `--under` names the deepest node the caller already knows exists, and bounds
  // what `-p` is allowed to build to what lies below it.
  //
  // Unbounded, `-p` means "rebuild whatever is gone", which is right for boot
  // and wrong for everything writing under a subject it did not create: a
  // pipeline step whose file was deleted mid-run would rebuild the file and
  // every level above it as `directory` nodes, an album among them. Naming the
  // boundary turns that into a failure at the missing node.
  const under = flagsUnder ? resolve(cmd.cwd, flagsUnder) : undefined;
  // '/' already ends in the separator; anything else needs one so `/a` is not
  // read as a prefix of `/ab`.
  const underPrefix = under === undefined ? undefined : under === '/' ? '/' : `${under}/`;

  const created: unknown[] = [];
  let failed = false;

  for (const flagsPath of flagsPaths) {
    try {
      const path = resolve(cmd.cwd, flagsPath);

      if (under && underPrefix) {
        if (!path.startsWith(underPrefix)) {
          throw new Error(`path is not under '${flagsUnder}'`);
        }

        if (!(await cmd.sys.vfs.exists(cmd.access, under))) {
          throw new Error(`'${flagsUnder}' does not exist`);
        }
      }

      if (ensure && await cmd.sys.vfs.exists(cmd.access, path)) {
        continue;
      }

      if (ensure) {
        // Like mkdir -p: missing parents are made as directories.
        let current = '';
        for (const part of dirname(path).split('/').filter(Boolean)) {
          const parent = current || '/';
          current = `${current}/${part}`;
          // At or above the boundary: it was just confirmed to exist, and anything
          // above an existing node exists too.
          if (underPrefix && !current.startsWith(underPrefix)) continue;
          if (!(await cmd.sys.vfs.exists(cmd.access, current))) {
            await cmd.sys.vfs.ensure(cmd.access, 'directory', parent, part, {});
          }
        }
      }

      const parent = dirname(path);
      const name = basename(path);
      // Fresh copies per operand: the VFS is free to fill defaults into what it
      // is handed, and one operand must not inherit them from the previous.
      const options = { props: { ...props }, attrs: { ...attrs } };
      const node = ensure ? await cmd.sys.vfs.ensure(cmd.access, flagsType, parent, name, options) : await cmd.sys.vfs.create(cmd.access, flagsType, parent, name, options);

      created.push(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`mknode: cannot create node '${flagsPath}': ${message}\n`);

      // Like mkdir(1): a bad operand does not abandon the ones after it, and the
      // exit status still reports that something went wrong.
      failed = true;
    }
  }

  if (cmd.json) {
    // One operand answers with the bare node; only a multi-operand call yields an array.
    await cmd.writeJSON(flagsPaths.length === 1 ? created[0] ?? null : created);
  } else if (!ensure && created.length > 0) {
    await cmd.write(`Node created successfully\n`);
  }

  return failed ? 1 : 0;
};

mknode.spec = {
  name: 'mknode',
  effect: 'write' as const,
  description: 'Create new or ensure node',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'node path to create; repeatable',
      variadic: true,
    },
  ],
  flags: [
    { name: 'p', type: 'bool' as const, description: 'if the path already exists, do nothing' },
    {
      name: 't',
      type: 'string' as const,
      description: 'type of node to make, required',
    },
    {
      name: 'under',
      type: 'string' as const,
      description: 'existing node the path must sit under; bounds what -p may create',
    },
    {
      name: 'tier',
      type: 'string' as const,
      description: "storage tier for a file's bytes: disk, volatile or db; fixed once created",
    },
    {
      name: 'as',
      type: 'string' as const,
      description: 'set attribute as string',
    },
    {
      name: 'an',
      type: 'number' as const,
      description: 'set attribute as number',
    },
    {
      name: 'aj',
      type: 'string' as const,
      description: 'set attribute as JSON',
    },
    {
      name: 'al',
      type: 'string' as const,
      description: 'set attribute as comma-separated list',
    },
    {
      name: 'm',
      type: 'string' as const,
      description: 'mode to set',
    },
    {
      name: 'o',
      type: 'string' as const,
      description: 'owner as uid or user name',
    },
    {
      name: 'g',
      type: 'string' as const,
      description: 'group as gid or group name',
    },
  ],
};
