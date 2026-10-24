import { CORE_ENVIRONMENT, PATH_DESCRIPTIONS } from '../../../../lib/reference/environment.ts';
import { listConfigOptions } from '../../../../lib/config/mod.ts';
import { pathEnv } from '../../../../lib/paths.ts';
import type { EnvVarDoc } from '../../../../lib/reference/types.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { describedBy } from './lib.ts';
import type { EnvReference } from '../../../../lib/api/docs.ts';

/** Names whose value is a credential: described, never echoed, wherever they come from. */
const SECRET = /SECRET|PASSWORD|PASSWD|TOKEN|(^|_)KEY$/;

/**
 * Every environment variable described, with its value in the calling shell, followed by what the
 * shell has set that nothing describes. Registered settings are left to `config list`.
 */
export const docsEnv = async (cmd: Command): CmdReturn => {
  try {
    const paths: EnvVarDoc[] = Object.keys(pathEnv())
      .filter((key) => key !== 'PATH' && key !== 'TMPDIR')
      .map((key) => ({ key, kind: 'path', description: PATH_DESCRIPTIONS[key] ?? '' }));
    const described = await describedBy<EnvVarDoc>(cmd, [...CORE_ENVIRONMENT, ...paths], 'environment');
    const settings = new Set(listConfigOptions().map((option) => option.key));

    const env = cmd.env as Record<string, unknown>;
    const valueOf = (key: string): string | undefined => typeof env[key] === 'string' ? env[key] as string : undefined;

    const result: EnvReference[] = described
      .filter((doc) => !settings.has(doc.key))
      .map((doc) => {
        const value = doc.kind === 'deployment' || SECRET.test(doc.key) ? undefined : valueOf(doc.key);
        return value === undefined ? doc : { ...doc, value };
      });
    const known = new Set(described.map((doc) => doc.key));
    for (const key of Object.keys(env).sort()) {
      const value = valueOf(key);
      // A `CFG_*` nobody registered is listed too: read somewhere, described nowhere, which is the gap to see.
      // Only exported-style names: the shell's own parameters (`$#`, `$0`) and a script's
      // lower-case locals ride in the same environment and are nobody's configuration.
      if (known.has(key) || settings.has(key) || value === undefined || !/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
      result.push({ key, kind: 'session', description: '', ...(SECRET.test(key) ? {} : { value }), undescribed: true });
    }

    if (cmd.json) {
      await cmd.writeJSON(result);
    } else {
      for (const entry of result) {
        const value = entry.value === undefined ? '' : `=${entry.value}`;
        await cmd.writeLn(`${entry.kind.padEnd(10)} ${entry.key}${value}${entry.description ? `  ${entry.description}` : ''}`);
      }
    }
    return 0;
  } catch (error) {
    await cmd.writeError(`docs env: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

docsEnv.spec = {
  name: 'docs-env',
  effect: 'read' as const,
  description: 'List the environment variables EiN and its modules read, with their values in this shell',
  args: [],
  flags: [],
  examples: ['docs env', 'docs env | grep PATH'],
  returns: 'One entry per variable: key, kind, description, default, owner module, and its value in this shell where it has one.',
};
