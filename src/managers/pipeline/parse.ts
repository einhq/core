import { parse as parseYaml } from '@std/yaml';
import { FILE_KINDS, isFileKind, type Kind } from '../../lib/kinds/mod.ts';
import { assertValidAttrRef, attrRefOf } from '../../vfs/query.ts';
import type { EntryPointCoverage, PipelineDef, PipelineStep, PipelineTrigger } from './types.ts';

export function parsePipeline(yaml: string): PipelineDef {
  const raw = parseYaml(yaml) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid pipeline: expected object');
  }

  if (typeof raw.name !== 'string' || !raw.name) {
    throw new Error('invalid pipeline: missing name');
  }

  if (raw.trigger === undefined && raw.triggers === undefined) {
    throw new Error('invalid pipeline: missing trigger or triggers');
  }

  if (raw.trigger !== undefined && raw.triggers !== undefined) {
    throw new Error("invalid pipeline: use either 'trigger' or 'triggers', not both");
  }

  if (!raw.steps || typeof raw.steps !== 'object') {
    throw new Error('invalid pipeline: missing steps');
  }

  const vars = raw.vars === undefined ? undefined : parseVars(raw.vars);
  const triggers = parseTriggers(raw.trigger ?? raw.triggers, vars);
  const steps = parseSteps(raw.steps as Record<string, unknown>);

  // Validate step dependencies reference existing steps
  const stepNames = new Set(Object.keys(steps));
  for (const [name, step] of Object.entries(steps)) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepNames.has(dep)) {
        throw new Error(`step '${name}' depends on unknown step '${dep}'`);
      }
    }
  }

  // Check for circular dependencies
  detectCycles(steps);

  const def: PipelineDef = {
    name: raw.name,
    triggers,
    steps,
  };

  if (typeof raw.description === 'string') {
    def.description = raw.description;
  }

  if (vars !== undefined) def.vars = vars;

  if (raw.options && typeof raw.options === 'object') {
    const opts = raw.options as Record<string, unknown>;
    def.options = {};
    if (typeof opts.maxAttempts === 'number') def.options.maxAttempts = opts.maxAttempts;
    if (typeof opts.priority === 'number') def.options.priority = opts.priority;
    if (opts.entryPoint !== undefined) def.options.entryPoint = parseEntryPoint(opts.entryPoint);
    if (opts.coalesce !== undefined) {
      if (opts.coalesce !== 'drop' && opts.coalesce !== 'rerun') {
        throw new Error(`invalid options.coalesce: expected 'drop' or 'rerun', got '${opts.coalesce}'`);
      }
      def.options.coalesce = opts.coalesce;
    }
    if (opts.debounceMs !== undefined) {
      if (typeof opts.debounceMs !== 'number' || !Number.isFinite(opts.debounceMs) || opts.debounceMs < 0) {
        throw new Error('invalid options.debounceMs: expected a non-negative number of milliseconds');
      }
      def.options.debounceMs = opts.debounceMs;
    }
  }

  return def;
}

/**
 * The `EVENT_*` names a definition interpolates, sorted and deduplicated.
 *
 * Substitution is textual and total: a name the engine cannot supply becomes
 * nothing at all, so `assign-faces $EVENT_FILE_PATH` runs as `assign-faces` and
 * the step fails as if the work had been attempted. Naming the references is
 * what lets a creation path say up front that it cannot supply them.
 *
 * Scans everything the engine substitutes against the instance env — step
 * commands and conditions, and the trigger's `skipIfExists`.
 */
export function eventVarsReferenced(def: PipelineDef): string[] {
  const found = new Set<string>();

  const scan = (text: string | undefined): void => {
    for (const match of text?.matchAll(/\$(EVENT_[A-Za-z0-9_]+)/g) ?? []) {
      found.add(match[1]);
    }
  };

  for (const step of Object.values(def.steps)) {
    scan(step.command);
    scan(step.condition);
  }
  for (const trigger of def.triggers) scan(trigger.skipIfExists);

  return [...found].sort();
}

/**
 * `entryPoint: true`, or the object form that also says how to measure coverage.
 *
 * An unknown kind throws rather than being dropped: a typo would otherwise
 * shrink the denominator silently.
 */
function parseEntryPoint(raw: unknown): boolean | EntryPointCoverage {
  if (typeof raw === 'boolean') return raw;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid options.entryPoint: expected a boolean or { kinds, marker, exempt? }');
  }

  const value = raw as Record<string, unknown>;

  if (!Array.isArray(value.kinds) || value.kinds.length === 0) {
    throw new Error('invalid options.entryPoint: kinds must be a non-empty list');
  }

  const kinds: Kind[] = [];
  for (const kind of value.kinds) {
    if (typeof kind !== 'string' || !isFileKind(kind)) {
      throw new Error(`invalid options.entryPoint: unknown kind '${kind}' (expected a file kind: ${FILE_KINDS.join(', ')})`);
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }

  if (typeof value.marker !== 'string' || !value.marker) {
    throw new Error('invalid options.entryPoint: marker must be the node type created per indexed file');
  }

  if (value.exempt !== undefined) {
    if (typeof value.exempt !== 'string' || !value.exempt) throw new Error('invalid options.entryPoint: exempt must name an attr');
    try {
      assertValidAttrRef(attrRefOf(value.exempt));
    } catch {
      throw new Error(`invalid options.entryPoint: exempt '${value.exempt}' is not an attr name`);
    }
    return { kinds, marker: value.marker, exempt: value.exempt };
  }

  return { kinds, marker: value.marker };
}

function parseTriggers(raw: unknown, declaredVars: Record<string, string> | undefined): PipelineTrigger[] {
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) throw new Error('invalid triggers: expected at least one trigger');

  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid trigger ${index + 1}: expected an object`);
    }
    return parseTrigger(value as Record<string, unknown>, declaredVars);
  });
}

function parseTrigger(
  raw: Record<string, unknown>,
  declaredVars: Record<string, string> | undefined,
): PipelineTrigger {
  const hasOn = raw.on !== undefined;
  const hasEvent = raw.event !== undefined;

  if (hasOn && hasEvent) {
    throw new Error("invalid trigger: 'on' (domain event) and 'event' (vfs event) are mutually exclusive");
  }

  const trigger: PipelineTrigger = {};

  if (hasOn) {
    const names = Array.isArray(raw.on) ? raw.on : [raw.on];

    for (const name of names) {
      if (typeof name !== 'string' || !name) {
        throw new Error("invalid trigger: 'on' must be an event type or a list of event types");
      }
    }

    if (names.length === 0) {
      throw new Error("invalid trigger: 'on' must name at least one event type");
    }

    trigger.on = names as string[];

    if (raw.nodeType !== undefined) {
      throw new Error("invalid trigger: 'nodeType' only applies to vfs triggers ('event')");
    }
  } else if (hasEvent) {
    if (typeof raw.event !== 'string') {
      throw new Error('invalid trigger: missing event');
    }
    if (typeof raw.nodeType !== 'string') {
      throw new Error('invalid trigger: missing nodeType');
    }

    trigger.event = raw.event;
    trigger.nodeType = raw.nodeType;
  } else {
    throw new Error("invalid trigger: expected 'on' (domain event) or 'event' + 'nodeType' (vfs event)");
  }

  if (raw.match !== undefined) trigger.match = parseGlobs(raw.match, 'match');

  if (raw.unless !== undefined) {
    const unless = parseGlobs(raw.unless, 'unless');
    // An empty `unless` matches every event, which would switch the trigger off
    if (Object.keys(unless).length === 0) throw new Error('invalid trigger: unless must name at least one field');
    trigger.unless = unless;
  }

  if (raw.skipIfExists !== undefined) {
    if (typeof raw.skipIfExists !== 'string' || !raw.skipIfExists) {
      throw new Error('invalid trigger: skipIfExists must be a non-empty path');
    }
    trigger.skipIfExists = raw.skipIfExists;
  }

  if (raw.skipIfAttr !== undefined) {
    if (typeof raw.skipIfAttr !== 'string' || !raw.skipIfAttr) {
      throw new Error('invalid trigger: skipIfAttr must be a non-empty attr name');
    }
    trigger.skipIfAttr = raw.skipIfAttr;
  }

  if (raw.allowDerived !== undefined) {
    if (typeof raw.allowDerived !== 'boolean') {
      throw new Error('invalid trigger: allowDerived must be a boolean');
    }
    trigger.allowDerived = raw.allowDerived;
  }

  if (typeof raw.filter === 'string') trigger.filter = raw.filter;
  if (typeof raw.skipIf === 'string') trigger.skipIf = raw.skipIf;

  if (raw.vars !== undefined) {
    const overrides = parseVars(raw.vars);
    for (const name of Object.keys(overrides)) {
      if (!(name in (declaredVars ?? {}))) {
        const known = Object.keys(declaredVars ?? {});
        throw new Error(
          `invalid trigger vars: pipeline declares no variable '${name}'${known.length ? ` (has ${known.join(', ')})` : ''}`,
        );
      }
    }
    trigger.vars = overrides;
  }

  if (raw.priority !== undefined) {
    if (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)) {
      throw new Error('invalid trigger: priority must be a finite number');
    }
    trigger.priority = raw.priority;
  }

  return trigger;
}

/** A trigger's `match` or `unless`: field names to a glob, or to a list of globs. */
function parseGlobs(raw: unknown, field: 'match' | 'unless'): Record<string, string | string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid trigger: ${field} must be an object of field: glob`);
  }

  const globs: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      globs[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      if (value.length === 0) throw new Error(`invalid trigger: ${field}.${key} must name at least one glob`);
      globs[key] = value as string[];
    } else {
      throw new Error(`invalid trigger: ${field}.${key} must be a glob or a list of globs`);
    }
  }

  return globs;
}

/**
 * Names the trigger env owns. A var of the same name would either be ignored
 * (the engine lets the trigger env win) or, for `PATH`, clobber the engine
 * shell's executable search — so it is rejected where the mistake is visible.
 */
const RESERVED_VARS = new Set(['NODE_PATH', 'PATH', 'MIMETYPE', 'NODE_TYPE']);

function parseVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid vars: expected an object of NAME: default');
  }

  const vars: Record<string, string> = {};

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid vars: '${name}' is not a valid variable name`);
    }
    if (RESERVED_VARS.has(name) || name.startsWith('EVENT_')) {
      throw new Error(`invalid vars: '${name}' is set by the trigger and cannot be declared`);
    }

    // `FORCE:` with nothing after it parses as null, which is the natural way to
    // write an empty default.
    if (value === null || value === undefined) {
      vars[name] = '';
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      vars[name] = String(value);
    } else {
      throw new Error(`invalid vars: ${name} must be a string, number, boolean or empty`);
    }
  }

  return vars;
}

function parseSteps(raw: Record<string, unknown>): Record<string, PipelineStep> {
  const steps: Record<string, PipelineStep> = {};

  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') {
      throw new Error(`step '${name}': expected object`);
    }

    const s = value as Record<string, unknown>;

    if (typeof s.command !== 'string' || !s.command) {
      throw new Error(`step '${name}': missing command`);
    }

    const step: PipelineStep = {
      command: s.command,
    };

    if (typeof s.description === 'string') step.description = s.description;
    if (typeof s.condition === 'string') step.condition = s.condition;
    // Every field needs an explicit branch: unknown keys are
    // dropped silently, so a typo'd `requires` would vanish and the step would
    // quietly run without its resource requirement.
    if (s.pool !== undefined) {
      if (typeof s.pool !== 'string' || !s.pool) {
        throw new Error(`step '${name}': pool must be a non-empty string`);
      }
      step.pool = s.pool;
    }

    if (s.kind !== undefined) {
      if (typeof s.kind !== 'string' || !s.kind) {
        throw new Error(`step '${name}': kind must be a non-empty string`);
      }
      step.kind = s.kind;
    }

    if (s.exclusive !== undefined) {
      if (typeof s.exclusive !== 'string' || !s.exclusive) {
        throw new Error(`step '${name}': exclusive must be a non-empty string`);
      }
      step.exclusive = s.exclusive;
    }

    if (s.priority !== undefined) {
      if (typeof s.priority !== 'number') {
        throw new Error(`step '${name}': priority must be a number`);
      }
      step.priority = s.priority;
    }

    if (s.requires !== undefined) {
      if (!s.requires || typeof s.requires !== 'object' || Array.isArray(s.requires)) {
        throw new Error(`step '${name}': requires must be an object of key: number`);
      }

      const requires: Record<string, number> = {};

      for (const [key, value] of Object.entries(s.requires as Record<string, unknown>)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`step '${name}': requires.${key} must be a finite number`);
        }
        requires[key] = value;
      }

      step.requires = requires;
    }

    if (Array.isArray(s.dependsOn)) {
      step.dependsOn = s.dependsOn.map((d) => {
        if (typeof d !== 'string') throw new Error(`step '${name}': dependsOn must be strings`);
        return d;
      });
    }

    steps[name] = step;
  }

  if (Object.keys(steps).length === 0) {
    throw new Error('pipeline must have at least one step');
  }

  return steps;
}

function detectCycles(steps: Record<string, PipelineStep>): void {
  const visited = new Set<string>();
  const stack = new Set<string>();

  function visit(name: string): void {
    if (stack.has(name)) {
      throw new Error(`circular dependency detected involving step '${name}'`);
    }
    if (visited.has(name)) return;

    stack.add(name);
    for (const dep of steps[name]?.dependsOn ?? []) {
      visit(dep);
    }
    stack.delete(name);
    visited.add(name);
  }

  for (const name of Object.keys(steps)) {
    visit(name);
  }
}
