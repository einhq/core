import type { Access } from '../../lib/access/mod.ts';
import { appAccess, appTokenDevice, findAppToken, touchAppToken } from '../../managers/devices/mod.ts';
import { createLogger } from '../../managers/logger/mod.ts';
import { getSession } from './session.ts';
import type { HttpServerConfig } from './types.ts';

const logger = createLogger('http');

/**
 * Who a request acts as where the EiN app's background work may send it: the account a phone was
 * paired as when it carries the app's token (`Authorization: Bearer`, `device-app`), else the
 * session's, never one made for it. Undefined for a token that is not a paired phone's now; `what`
 * names the request in the warning logged then.
 */
export async function appOrSessionAccess(config: HttpServerConfig, req: Request, from: string | undefined, what: string): Promise<Access | undefined> {
  const token = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (token === undefined) return (await getSession(config, req.headers, { create: false })).access;
  if (appTokenDevice(token) === undefined) return undefined;
  const app = await findAppToken(config.vfs, token);
  const access = app && await appAccess(config.vfs, app.by);
  if (!app || !access) {
    logger.warn(`${what} with an app token was refused`, { from });
    return undefined;
  }
  await touchAppToken(config.vfs, app, from);
  return access;
}
