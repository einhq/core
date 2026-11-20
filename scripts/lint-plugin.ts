/**
 * EiN's own `deno lint` rules, loaded by core's `deno.jsonc` and so by every module's check too.
 *
 * `ui-date-locale`: in the Web UI's code, core's (`src/builtin/ui/src/`) and a module's
 * (`modules/<name>/ui/`), a date is written with `@ein/ui/lib`'s helpers, which follow the reader's
 * time locale setting, never by the browser's language. It refuses `toLocaleDateString` and
 * `toLocaleTimeString`, `toLocaleString` on what reads as a date, and an `Intl.DateTimeFormat` made
 * without a locale. Lint sees no types, so a date is told from a number by its shape: `new Date(…)`,
 * date or time options such as `{ hour: 'numeric' }`, or a name such as `date`, `at` or `createdAt`;
 * `count.toLocaleString()` stays allowed.
 */

const UI_FILE = /\/(src\/builtin\/ui\/src|modules\/[^/]+\/ui)\//;

/** The options only a date or time takes. */
const DATE_OPTIONS = new Set([
  'dateStyle',
  'timeStyle',
  'weekday',
  'era',
  'year',
  'month',
  'day',
  'dayPeriod',
  'hour',
  'minute',
  'second',
  'fractionalSecondDigits',
  'hour12',
  'hourCycle',
  'timeZone',
  'timeZoneName',
]);

/** A name that says it holds a date: `date`, `at`, `when`, `startTime`, `createdAt` and the like. */
const DATE_NAME = /^([Dd]ate|[Tt]ime|at|when|[Tt]imestamp)$|[a-z0-9](Date|Time|At|Timestamp)$/;

const HELPERS: Record<string, string> = {
  toLocaleString: 'formatDateTime',
  toLocaleDateString: 'formatDate',
  toLocaleTimeString: 'formatTime',
};

type Node = Deno.lint.Node;

const nameOf = (node: Node): string | undefined => {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return node.property.name;
  return undefined;
};

/** `Intl.DateTimeFormat`, the callee of a call or `new`. */
const isDateTimeFormat = (node: Node): boolean =>
  node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'Intl' && nameOf(node) === 'DateTimeFormat';

/** A locale argument that leaves the choice to the browser: none, `undefined`, `[]` or `navigator.language(s)`. */
const isBrowserLocale = (node: Node | undefined): boolean => {
  if (!node) return true;
  if (node.type === 'Identifier') return node.name === 'undefined';
  if (node.type === 'UnaryExpression') return node.operator === 'void';
  if (node.type === 'ArrayExpression') return node.elements.length === 0;
  if (node.type === 'MemberExpression') return node.object.type === 'Identifier' && node.object.name === 'navigator' && /^languages?$/.test(nameOf(node) ?? '');
  return false;
};

const hasDateOptions = (args: Node[]): boolean =>
  args.some((arg) =>
    arg.type === 'ObjectExpression' &&
    arg.properties.some((property) =>
      property.type === 'Property' &&
      !property.computed &&
      DATE_OPTIONS.has(property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? String(property.key.value) : '')
    )
  );

const isDateValue = (node: Node): boolean => {
  if (node.type === 'NewExpression') return nameOf(node.callee) === 'Date' || (node.callee.type === 'MemberExpression' && nameOf(node.callee.object) === 'Temporal');
  return DATE_NAME.test(nameOf(node) ?? '');
};

const plugin: Deno.lint.Plugin = {
  name: 'ein',
  rules: {
    'ui-date-locale': {
      create(context) {
        if (!UI_FILE.test(context.filename.replaceAll('\\', '/'))) return {};
        const checkFormat = (node: Deno.lint.CallExpression | Deno.lint.NewExpression) => {
          if (!isDateTimeFormat(node.callee) || !isBrowserLocale(node.arguments[0])) return;
          // Reading the browser's own time zone or calendar is not writing a date.
          if (node.parent.type === 'MemberExpression' && node.parent.object === node && nameOf(node.parent) === 'resolvedOptions') return;
          context.report({
            node,
            message: "Intl.DateTimeFormat without a locale writes dates in the browser's language, not the time locale setting",
            hint: "Use dateTimeFormat(options) from '@ein/ui/lib', or name the locale the text must be in",
          });
        };
        return {
          NewExpression: checkFormat,
          CallExpression(node) {
            checkFormat(node);
            const callee = node.callee;
            const method = nameOf(callee);
            if (callee.type !== 'MemberExpression' || !method || !Object.hasOwn(HELPERS, method)) return;
            if (method === 'toLocaleString' && !isDateValue(callee.object) && !hasDateOptions(node.arguments)) return;
            context.report({
              node,
              message: `${method} writes dates in the browser's language, not the time locale setting`,
              hint: `Use ${HELPERS[method]}(…) from '@ein/ui/lib'; a number's toLocaleString that reads as a date takes // deno-lint-ignore ein/ui-date-locale`,
            });
          },
        };
      },
    },
  },
};

export default plugin;
