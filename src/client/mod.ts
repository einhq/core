/**
 * `@ein/client` — the module-facing API, and the only thing module code may import.
 *
 * Modules are meant to be distributable from their own repositories, so they cannot depend on
 * core internals. `@ein/exec` is not that boundary: it re-exports the `Cmd` implementation,
 * the exec manager and the execution manager — roughly a thousand lines of machinery a module
 * has no business seeing. This file is the boundary, and it is deliberately small.
 *
 * It is sized to what modules actually use rather than to what core happens to expose: on the
 * command object only `sys.vfs` and `sys.devices`, never `bufferManager`, `routerManager` or
 * `execManager`. Widening any of this is additive and safe; narrowing it is not.
 *
 * Core keeps importing `@ein/exec` internally. The two are expected to diverge: this one is
 * a published contract with a version, that one is whatever core needs today.
 */

import type { Access } from '../lib/access/types.ts';
import type { ResourceHandleIf } from '../registries/types.ts';
import type { EchoMode } from '../managers/shell/readline/mod.ts';
import type { ModuleVFS } from '../vfs/node-vfs.ts';
import type { CmdSpec } from '../managers/exec/spec.ts';
import type { Input } from '../managers/exec/command-input.ts';
import type { ModuleDevices } from '../managers/devices/types.ts';

/**
 * What a module sees of `SystemCore`.
 *
 * `vfs`, and `devices` for a module that drives devices. A module reaching for the buffer or router
 * managers is a design smell that should surface as a type error rather than as a working
 * import — the shell is the intended route to anything else. The VFS is core's `ModuleVFS`,
 * exported here as `NodeVFS`: without the store's lifecycle, mounting, the pool worker's side and
 * the storage administration core's own `NodeVFS` adds, which change with core's storage work.
 */
export type ModuleSystemCore = {
  vfs: ModuleVFS;
  /** The devices under `/dev`: registering a driver, and the writes a driver makes. */
  devices?: ModuleDevices;
};

/**
 * The command object handed to a module command.
 *
 * A structural subset of core's `Command` (`src/managers/exec/command.ts`), so the real `Cmd`
 * instance satisfies it without adaptation. Dropped on purpose: `login`/`logout` (auth is not a
 * module's business), `setRawMode`/`resize`/`onResize` (terminal control belongs to
 * interactive builtins), `kill`/`onSignal`/`signal`/`interruptSignal` and
 * `init`/`dispose` (process lifecycle is the execution manager's), and `id`/`parentId`/`opts`/
 * `detached`/`forground`/`stdinId`.
 *
 * Note there is no `flags`: flags are parsed from `args` with `parseArgs` from `@ein/client`.
 */
export interface Command {
  readonly sys: ModuleSystemCore;

  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly access: Access;
  readonly name: string;
  readonly args: string[];
  /** True when the caller wants machine-readable output. */
  readonly json: boolean;
  readonly tty: boolean;
  readonly rows: number;
  readonly cols: number;
  readonly interrupted: boolean;

  readonly stdout: ResourceHandleIf;
  readonly stderr: ResourceHandleIf;
  /** Stdin, read as bytes, lines or text: `for await (const line of cmd.stdin.lines())`. */
  readonly stdin: Input;
  openStdin(): Promise<ResourceHandleIf>;

  /** Call `handler` on a terminating signal; at once if the command is already interrupted. */
  onInterrupt(handler: (() => void) | null): void;

  /**
   * Ask on the terminal and read the answer. A command with no terminal (no `tty`) is not asked: it
   * fails at once with `<name>: no terminal to answer on; <instead>`, `instead` saying how to give
   * the answer without one (`add --force`).
   */
  prompt(prompt?: string, echoMode?: EchoMode, instead?: string): Promise<string>;
  write(data: string): Promise<void>;
  writeLn(data: string): Promise<void>;
  writeJSON(data: any, pretty?: boolean): Promise<void>;
  writeYAML(data: any): Promise<void>;
  writeError(data: string): Promise<void>;

  /**
   * Say how much of its work the command has done, from 0 to 1. A pipeline step shows the last
   * value beside the step while it runs; elsewhere it goes nowhere. For work that takes minutes:
   * what the fraction counts is the command's own business.
   */
  progress(fraction: number): void;

  /**
   * Run a script and capture its output. Quote interpolated paths with `shq`. Past `timeoutMs` the
   * script is stopped and the result has `timedOut` set.
   */
  execute(script: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /** Run a script inline, streaming its output to this command's stdout/stderr. */
  executeInline(script: string): Promise<number>;
}

/** Every module command returns its exit code. */
export type CmdReturn = Promise<number>;

/** A module command: a default-exported function carrying a `spec`. */
export type CmdFunction = ((cmd: Command) => CmdReturn) & {
  spec: CmdSpec;
};

export type { ArgCompleteType, CmdArgDef, CmdEffect, CmdFlagDef, CmdSpec, CmdWordDef, FlagCompleteType } from '../managers/exec/spec.ts';
export type { Input } from '../managers/exec/command-input.ts';

/** Whether a shell line changes anything, from its parse and the commands' specs. See `effect.ts`. */
export { commandsIn, judgeLine, type Judgement, type SpecLookup } from '../managers/exec/effect.ts';
/**
 * A command's spec as a tool schema, and a tool call back as the line to run.
 *
 * Exported here because a module is where an agent lives: the assistant offers the archive's
 * commands to a model, and generating that offer from each command's own spec is what keeps
 * the two from drifting. See `src/managers/exec/tool-schema.ts`.
 */
export { toolCallToCommandLine, toolSchema } from '../managers/exec/tool-schema.ts';
export type { ToolParameterSchema, ToolSchema } from '../managers/exec/tool-schema.ts';

/* Access and permissions */
export type { Access, AccessLevel } from '../lib/access/types.ts';
export { ADMIN_ACCESS } from '../lib/access/constants.ts';
export { isAdmin, isVisitor, nodeOwnership, verifyAccess } from '../lib/access/verify-access.ts';
/** The access an account signs in with, for work done on its behalf: `accessOfUser(vfs, access, username)`. */
export { accessOfUser } from '../lib/auth/member-gids.ts';
export { type DefaultOwnership, resolveDefaultOwnership } from '../lib/access/default-ownership.ts';
export { applySharePreference, type SharePreference } from '../lib/access/share-preference.ts';

/* Settings, read as policy rather than from this shell's environment snapshot */
export { guestMayBrowse, readSettings, serviceKey, type SettingsContext } from '../lib/config/read-settings.ts';
export type { GroupId, Mode, UserId } from '../lib/mode/mod.ts';

/* VFS — the surface behind `cmd.sys.vfs` */
export type { ModuleVFS as NodeVFS } from '../vfs/node-vfs.ts';
export type { Node, NodeAttrs, NodeChild, NodeId, NodePath, NodeProps, NodeType } from '../vfs/node.ts';
export type {
  ChildrenOptions,
  CopyOptions,
  NodeAttrsUpdate,
  NodeChildEntry,
  NodeEntry,
  NodeEvent,
  NodeEventType,
  NodePropsUpdate,
  NodeReference,
  NodeResolveOptions,
} from '../vfs/types.ts';
export type {
  AggregateBucket,
  AttrCondition,
  AttrPathRef,
  AttrRef,
  LinkEntry,
  NodeAggregateQuery,
  NodeQuery,
  NodeQueryCollation,
  NodeQueryCursor,
  NodeQueryEntry,
  NodeQueryOrder,
  NodeQueryRow,
  ResolvedPath,
} from '../vfs/query.ts';
export { NodeAccessDeniedError, NodeAlreadyExistsError, NodeError, NodeNotFoundError } from '../vfs/errors.ts';
export type { ResourceHandleIf } from '../registries/types.ts';

/* Shell helpers */
export { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../lib/args/mod.ts';
export { shq } from '../lib/shell-quote/mod.ts';
export { type StepPhase, stepPhase } from '../lib/step-phase.ts';
export { STEP_EXIT_INPUT, STEP_EXIT_TEMPORARY } from '../lib/step-exit.ts';
/** What a service's `checkCommand` and `gaugeCommand` answer (see `ServiceConfig`). */
export type { Gauge, HealthCheck } from '../lib/api/system.ts';

/* Domain events */
export { type DomainEvent, EVENTS_NODE_PATH, EVENTS_ROUTING_KEY, PIPELINE_EVENTS_NODE_PATH, PIPELINE_EVENTS_ROUTING_KEY } from '../lib/events/mod.ts';

/* Capture times: the one string a file's date is, and the instant it names */
export {
  type CaptureTimeParts,
  isCaptureTime,
  lowerBound,
  parseCaptureTime,
  type TimePrecision,
  toUtc,
  upperBoundExclusive,
  wallClockOf,
  withOffset,
} from '../lib/capture-time/mod.ts';
export { SYSTEM_TIME_ZONE } from '../lib/datetime/mod.ts';

/* Media predicates that are core's to define (mimetype tables live in src/lib/media) */
export { isRawExtension, isRawMimetype, RAW_IMAGE_MIMETYPES, refineMimeByName } from '../lib/media/raw.ts';
export { isOriginalMedia } from '../lib/media/original.ts';
// The rendition table in /etc/renditions.yaml, for the commands that make renditions; its shape and
// the rules over it (which file a role is, which roles a picture gets) are `@ein/api`'s.
export { readRenditionTable, type RenditionTableRead } from '../lib/media/renditions.ts';

// The store condition for a file that is no other file's derivative.
export { NOT_DERIVED } from '../lib/kinds/mod.ts';

/* A node's cover picture, and distance on the map */
export { COVER_LINK_NAME, setCover, type SetCoverOptions } from '../lib/cover/mod.ts';
export { haversineMeters } from '../lib/geo/distance.ts';

/* Node comments, read by aggregate commands like media-details */
export { type CommentEntry, readComments } from '../lib/comments/mod.ts';

/* What a `members-<type>` command answers `members` and `search --under` with */
export type { ContainerListing, ContainerMember } from '../lib/containers/types.ts';

/* What a `subject-<kind>` command answers `search --subject` with */
export type { SubjectEntry, SubjectListing, SubjectMatch, SubjectsOf } from '../lib/subjects/types.ts';

// Plane geometry over the position registry's shapes.
export { pointInPolygon } from '../registries/position/geo.ts';
export type { GeoBounds, PositionData, PositionFilter, PositionPoint, WithinMatch } from '../registries/position/types.ts';

// What the track registry knows about a track without reading its points (`NodeVFS.trackSummaries`).
export type { TrackSummary } from '../registries/track/types.ts';
// GPX documents read into fixes.
export { type Gpx, isGpx, parseGpx, timedPoints } from '../lib/track/gpx.ts';

// Devices: a module's drivers and the writes they make (`cmd.sys.devices`).
export type { AppendOptions, Driver, DriverAnswer, DriverInput, DriverWrite, ModuleDevices } from '../managers/devices/types.ts';

// A series out of a log: the latest samples of a metrics series, core's own or one a module's
// service keeps, or any log's entries by time, as they are or summed up per interval.
export { readBuckets, readRange, readTail } from '../lib/metrics/read.ts';
export type { BucketSample, Sample } from '../lib/metrics/sample.ts';
export type { LogAggregate, LogBucketQuery } from '../registries/log/types.ts';
export { seriesPath } from '../lib/metrics/series.ts';
// The pool matched triggers wait in before they are instances: in core's `pools` series, the work
// not started yet, as against the work pools' work in line for a worker.
export { TRIGGER_POOL } from '../managers/pipeline/types.ts';

export type { UserAttrs } from '../vfs/types/user.ts';

// What a label marks, for a module that answers a narrower question than `search` does
// (archive's map). The command itself is `search`.
export { taggedPaths } from '../lib/search/sources.ts';

// What a module's view of the whole library leaves out, as `search` does: the trees under an
// unlisted directory, and which of a batch of nodes lie in one.
export { isUnlistedPath, UNLISTED_ATTR, unlistedIds, unlistedRoots } from '../lib/search/unlisted.ts';

// Which processing a folder wants, as the pipeline engine reads it for a trigger's `wants`: for a
// module's own tree, and for a pass that looks for missing work and must leave out what a folder
// does not want.
export { familiesOf, PROCESSING_ATTR, processingAt, type ProcessingRoot, processingRoots, wantsProcessing } from '../lib/processing.ts';

// The command catalogue: every command on the caller's PATH with its spec.
export { type CatalogueEntry, commandCatalogue, forgetCommandCatalogues } from '../lib/commands/catalogue.ts';
