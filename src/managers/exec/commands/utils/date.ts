import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

/** A date in a strftime-like format. */
function formatDate(d: Date, format: string): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayNamesShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let result = '';
  let i = 0;

  while (i < format.length) {
    if (format[i] === '%' && i + 1 < format.length) {
      const spec = format[i + 1];
      switch (spec) {
        case 'Y': // 4-digit year
          result += d.getFullYear();
          break;
        case 'y': // 2-digit year
          result += pad(d.getFullYear() % 100);
          break;
        case 'm': // Month (01-12)
          result += pad(d.getMonth() + 1);
          break;
        case 'd': // Day of month (01-31)
          result += pad(d.getDate());
          break;
        case 'e': // Day of month, space-padded
          result += String(d.getDate()).padStart(2, ' ');
          break;
        case 'H': // Hour (00-23)
          result += pad(d.getHours());
          break;
        case 'I': // Hour (01-12)
          result += pad(d.getHours() % 12 || 12);
          break;
        case 'M': // Minute (00-59)
          result += pad(d.getMinutes());
          break;
        case 'S': // Second (00-59)
          result += pad(d.getSeconds());
          break;
        case 'p': // AM/PM
          result += d.getHours() < 12 ? 'AM' : 'PM';
          break;
        case 'P': // am/pm
          result += d.getHours() < 12 ? 'am' : 'pm';
          break;
        case 'A': // Full weekday name
          result += dayNames[d.getDay()];
          break;
        case 'a': // Abbreviated weekday name
          result += dayNamesShort[d.getDay()];
          break;
        case 'B': // Full month name
          result += monthNames[d.getMonth()];
          break;
        case 'b':
        case 'h': // Abbreviated month name
          result += monthNamesShort[d.getMonth()];
          break;
        case 'j': // Day of year (001-366)
          {
            const start = new Date(d.getFullYear(), 0, 0);
            const diff = d.getTime() - start.getTime();
            const oneDay = 1000 * 60 * 60 * 24;
            result += pad(Math.floor(diff / oneDay), 3);
          }
          break;
        case 'u': // Day of week (1-7, Monday=1)
          result += d.getDay() || 7;
          break;
        case 'w': // Day of week (0-6, Sunday=0)
          result += d.getDay();
          break;
        case 'Z': // Timezone name
          result += Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')
            ?.value ?? '';
          break;
        case 'z': // Timezone offset
          {
            const offset = -d.getTimezoneOffset();
            const sign = offset >= 0 ? '+' : '-';
            const hours = pad(Math.floor(Math.abs(offset) / 60));
            const mins = pad(Math.abs(offset) % 60);
            result += `${sign}${hours}${mins}`;
          }
          break;
        case 's': // Unix timestamp
          result += Math.floor(d.getTime() / 1000);
          break;
        case 'N': // Nanoseconds
          result += pad(d.getMilliseconds() * 1000000, 9);
          break;
        case 'n': // Newline
          result += '\n';
          break;
        case 't': // Tab
          result += '\t';
          break;
        case '%': // Literal %
          result += '%';
          break;
        case 'F': // %Y-%m-%d
          result += `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          break;
        case 'T': // %H:%M:%S
          result += `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          break;
        case 'R': // %H:%M
          result += `${pad(d.getHours())}:${pad(d.getMinutes())}`;
          break;
        case 'D': // %m/%d/%y
          result += `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
          break;
        default:
          result += '%' + spec;
      }
      i += 2;
    } else {
      result += format[i];
      i++;
    }
  }

  return result;
}

export const date = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      d: 'date',
      u: 'utc',
      I: 'iso-8601',
      R: 'rfc-email',
    },
    string: ['d', 'I'],
    boolean: ['u', 'R'],
  });

  let d: Date;

  if (flags.date) {
    d = new Date(flags.date);
    if (isNaN(d.getTime())) {
      await cmd.writeError(`date: invalid date '${flags.date}'\n`);
      return 1;
    }
  } else {
    d = new Date();
  }

  if (flags.utc) {
    d = new Date(d.toUTCString());
  }

  // A +FORMAT operand.
  const formatArg = flags._.find((a) => String(a).startsWith('+'));
  let output: string;

  if (formatArg) {
    output = formatDate(d, String(formatArg).slice(1));
  } else if (flags['iso-8601'] !== undefined) {
    // ISO 8601 format
    const precision = flags['iso-8601'] || 'date';
    switch (precision) {
      case 'hours':
        output = formatDate(d, '%Y-%m-%dT%H%z');
        break;
      case 'minutes':
        output = formatDate(d, '%Y-%m-%dT%H:%M%z');
        break;
      case 'seconds':
        output = formatDate(d, '%Y-%m-%dT%H:%M:%S%z');
        break;
      case 'ns':
        output = formatDate(d, '%Y-%m-%dT%H:%M:%S,%N%z');
        break;
      case 'date':
      default:
        output = formatDate(d, '%Y-%m-%d');
    }
  } else if (flags['rfc-email']) {
    // RFC 5322 format
    output = formatDate(d, '%a, %d %b %Y %H:%M:%S %z');
  } else {
    output = formatDate(d, '%a %b %e %H:%M:%S %Z %Y');
  }

  await cmd.write(`${output}\n`);

  return 0;
};

date.spec = {
  name: 'date',
  effect: 'read' as const,
  json: false,
  description: 'Print or set the system date and time',
  args: [
    {
      name: '+FORMAT',
      type: 'string' as const,
      description: 'output format (strftime-style)',
    },
  ],
  flags: [
    { name: 'd', type: 'string' as const, description: 'display time described by STRING, not now' },
    { name: 'u', type: 'bool' as const, description: 'print or set UTC time' },
    { name: 'I', type: 'string' as const, description: 'output in ISO 8601 format (date, hours, minutes, seconds, ns)' },
    { name: 'R', type: 'bool' as const, description: 'output in RFC 5322 format' },
  ],
};
