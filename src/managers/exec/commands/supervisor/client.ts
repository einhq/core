/**
 * Requests to the supervisor beside EiN (`CFG_SUPERVISOR_URL`), which holds the container engine's
 * socket that EiN never gets, and installs and updates a fixed set of services when asked. It is
 * asked with `CFG_SUPERVISOR_KEY`, sent only to the system's own address (`serviceKey`).
 */

import { readSettings, serviceKey } from '../../../../lib/config/read-settings.ts';
import type { Command } from '../../command.ts';

/** How long the supervisor has to answer: it reads its containers, or starts a job, and returns. */
const SUPERVISOR_TIMEOUT_MS = 20_000;

/** The supervisor's address as the settings hold it now, or nothing in an installation without one. */
export const supervisorUrl = async (cmd: Command): Promise<string | undefined> => {
  const settings = await readSettings(cmd, cmd.access, { user: false });
  return settings.CFG_SUPERVISOR_URL?.replace(/\/+$/, '') || undefined;
};

/** The supervisor's JSON answer to a request; an error carrying what it said when it refuses. */
export const askSupervisor = async <T>(cmd: Command, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
  const url = await supervisorUrl(cmd);
  if (!url) throw new Error('this installation has no supervisor: setup.sh installs and updates its services');
  // The key goes to the system's own address alone, whatever address this command was given.
  const key = await serviceKey({ sys: cmd.sys, env: { ...cmd.env, CFG_SUPERVISOR_URL: url } }, 'CFG_SUPERVISOR_KEY', 'CFG_SUPERVISOR_URL');
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([cmd.interruptSignal, AbortSignal.timeout(SUPERVISOR_TIMEOUT_MS)]),
    });
  } catch (error) {
    throw new Error(`the supervisor at ${url} does not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let answer: unknown;
  try {
    answer = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`the supervisor answered ${response.status} with something other than JSON`);
  }
  if (!response.ok) {
    const said = (answer as { error?: unknown }).error;
    throw new Error(typeof said === 'string' ? said : `the supervisor answered ${response.status}`);
  }
  return answer as T;
};

/** Who asks, as the supervisor keeps it with the job. */
export const asker = (cmd: Command): string => cmd.env.USER || 'EiN';
