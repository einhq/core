import { MaskACL, MaskGroup, MaskOther, MaskOwner, MaskWho, MaskWhoKeys, MODE_STICKY } from './constants.ts';
import { ChownLookup, GroupId, Mode, ModeMask, ModeStringOptions, SimpleOwnership, UserId } from './types.ts';

export const getMode = (modestr: string, masks: ModeMask) => {
  let mode = 0;

  mode |= modestr.includes('r') ? masks.READ : 0;
  mode |= modestr.includes('w') ? masks.WRITE : 0;
  mode |= modestr.includes('x') ? masks.EXEC : 0;

  return mode;
};

export const checkMode = (mode: number, modestr: string, masks: ModeMask) => {
  const modeLevel = getMode(modestr, masks);

  return (mode & modeLevel) > 0;
};

export const modeStringMask = (mode: Mode, mask: ModeMask) => {
  let str = '';

  str += mode & mask.READ ? 'r' : '-';
  str += mode & mask.WRITE ? 'w' : '-';
  str += mode & mask.EXEC ? 'x' : '-';

  return str;
};

export const getModeString = (mode: Mode, options?: ModeStringOptions) => {
  let modestr = '';

  if (options?.acl) {
    modestr += modeStringMask(mode, MaskACL);
  }

  if (!options || options?.owner) {
    modestr += modeStringMask(mode, MaskOwner);
  }

  if (!options || options?.group) {
    modestr += modeStringMask(mode, MaskGroup);
  }

  if (!options || options?.other) {
    // The sticky bit takes the others' execute position, as `ls` shows it: `t`, or `T` without execute.
    const other = modeStringMask(mode, MaskOther);
    modestr += mode & MODE_STICKY ? other.slice(0, 2) + (other[2] === 'x' ? 't' : 'T') : other;
  }

  return modestr;
};

export const chmodToMode = (chown: string, baseMode: Mode = 0): Mode => {
  // --- Numeric mode (e.g. 755, 0644, 1777). A leading digit may give the sticky bit only: EiN has
  // no setuid or setgid.
  if (/^[0-7]{3,4}$/.test(chown)) {
    if (/^[2-7][0-7]{3}$/.test(chown)) throw new Error(`invalid mode: "${chown}" (EiN has no setuid or setgid bit)`);
    return Number.parseInt(chown, 8);
  }

  let mode = baseMode;

  const clauses = chown.split(',');

  for (const clause of clauses) {
    // An empty `=` clears the class, as `chmod o=` does; an empty `+` or `-` changes nothing.
    // `t` is the sticky bit, which belongs to the others' class: `+t`, `o+t` and `a+t` set it.
    const match = clause.match(/^([ugoa]*)([+=-])([rwxt]*)$/);
    if (!match) {
      throw new Error(`invalid mode clause: "${clause}"`);
    }

    const [, who, op, perms] = match;

    const targets = who === '' || who.includes('a') ? MaskWhoKeys : [...who] as Array<'u' | 'g' | 'o'>;

    for (const t of targets) {
      const mask = MaskWho[t];

      let permBits = 0;
      if (perms.includes('r')) permBits |= mask.READ;
      if (perms.includes('w')) permBits |= mask.WRITE;
      if (perms.includes('x')) permBits |= mask.EXEC;
      if (perms.includes('t') && t === 'o') permBits |= MODE_STICKY;

      switch (op) {
        case '+':
          mode |= permBits;
          break;
        case '-':
          mode &= ~permBits;
          break;
        case '=':
          // clear r/w/x for this class first, and the others' the sticky bit
          mode &= ~(mask.READ | mask.WRITE | mask.EXEC | (t === 'o' ? MODE_STICKY : 0));
          mode |= permBits;
          break;
      }
    }
  }

  return mode;
};

export const parseChown = async (spec: string, lookup: ChownLookup): Promise<SimpleOwnership> => {
  if (!spec) {
    throw new Error('empty chown spec');
  }

  const sep = spec.includes(':') ? ':' : spec.includes('.') ? '.' : null;

  let userPart: string | undefined;
  let groupPart: string | undefined;

  if (sep) {
    [userPart, groupPart] = spec.split(sep, 2);
  } else {
    userPart = spec;
  }

  const result: SimpleOwnership = {};

  if (userPart !== undefined && userPart !== '') {
    result.uid = await resolveUser(userPart, lookup);
  }

  if (groupPart !== undefined && groupPart !== '') {
    result.gid = await resolveGroup(groupPart, lookup);
  }

  if (result.uid === undefined && result.gid === undefined) {
    throw new Error(`invalid chown spec: "${spec}"`);
  }

  return result;
};

async function resolveUser(value: string, lookup: ChownLookup): Promise<UserId> {
  const n = Number.parseInt(value, 10);
  if (!Number.isNaN(n)) {
    return n;
  }

  const uid = await lookup.user(value);
  if (uid === undefined) {
    throw new Error(`unknown user: "${value}"`);
  }

  return uid;
}

async function resolveGroup(value: string, lookup: ChownLookup): Promise<GroupId> {
  const n = Number.parseInt(value, 10);
  if (!Number.isNaN(n)) {
    return n;
  }

  const gid = await lookup.group(value);
  if (gid === undefined) {
    throw new Error(`unknown group: "${value}"`);
  }

  return gid;
}
