import { ExecContextIf } from '@ein/bash-executor';

/** The prompt when PS1 is unset: `user@host:path$ `, the name in green, or in red as an administrator. */
export function defaultPS1(admin: boolean): string {
  return '\\[\\e[1m\\]' + // bold on
    `\\[\\e[${admin ? 31 : 32}m\\]\\u@\\h` + // username@host, red for an administrator
    '\\[\\e[39m\\]:' + // reset color (keep bold)
    '\\[\\e[34m\\]\\w' + // blue path
    '\\[\\e[39m\\]\\$ ' + // reset color before $
    '\\[\\e[0m\\]'; // full reset at end
}

/**
 * Expand PS1's `\u`, `\h`, `\w`, `\W`, `\$`, `\n`, `\t`, `\T` and `\e` into the prompt. `\$` is `#`
 * when the shell acts as an administrator — the administrator's own sign-in or an elevated one
 * (`user-elevate`, `admin`) — as it is for root in bash, and `$` otherwise.
 */
export function expandPS1(ctx: ExecContextIf, ps1: string, admin: boolean): string {
  const env = ctx.getEnv();
  const cwd = ctx.getCwd();
  const user = env.USER ?? '';
  const host = env.HOSTNAME?.split('.')[0] ?? '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  const replacements: Record<string, string> = {
    '\\u': user,
    '\\h': host,
    '\\w': cwd.replace(env.HOME, '~'),
    '\\W': cwd.split('/').pop() || '/',
    '\\$': admin ? '#' : '$',
    '\\n': '\n',
    '\\t': `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    '\\T': `${((now.getHours() + 11) % 12 + 1)}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  };

  let out = ps1;

  // Bash's non-printing markers \[ \]
  out = out.replace(/\\\[|\\\]/g, '');

  for (const [k, v] of Object.entries(replacements)) {
    out = out.split(k).join(v);
  }

  out = out.replace(/\\e/g, '\x1b');

  return out;
}
