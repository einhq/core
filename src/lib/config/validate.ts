import type { ConfigOption } from './types.ts';

/**
 * Whether `value` is acceptable for `option`, as a message or nothing.
 *
 * Deliberately permissive about *meaning* and strict about *shape*: this
 * cannot tell whether 32 GB of VRAM exists, but it can stop `abc` reaching a
 * number and a mode being written as `rwxr-xr-x` when the consuming site
 * parses octal. Names of users and groups are checked for shape here and
 * resolved for real at the point of use, where the VFS is available.
 */
export const validateConfigValue = (option: ConfigOption, value: string): string | undefined => {
  if (value === '') {
    // An empty value is how an option says "fall back to something contextual"
    // — the default owner being whoever creates it, for instance.
    return option.emptyMeans !== undefined ? undefined : `${option.key}: value must not be empty`;
  }

  switch (option.type) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return `${option.key}: expected a number, got '${value}'`;
      return undefined;
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') return `${option.key}: expected 'true' or 'false', got '${value}'`;
      return undefined;
    }
    case 'select': {
      if (!option.choices?.includes(value)) {
        return `${option.key}: expected one of ${option.choices?.join(', ')}, got '${value}'`;
      }
      return undefined;
    }
    case 'mode': {
      if (!/^0?[0-7]{3,4}$/.test(value)) return `${option.key}: expected an octal mode such as 0750, got '${value}'`;
      return undefined;
    }
    case 'user':
    case 'group': {
      if (!/^[A-Za-z0-9._-]+$/.test(value)) return `${option.key}: '${value}' is not a valid ${option.type} name`;
      return undefined;
    }
    case 'string':
    case 'secret':
      return undefined;
  }
};
