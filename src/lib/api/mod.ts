/**
 * What core's commands answer with under `JSON_OUTPUT=1`, as types (`@ein/api`), with the few
 * values and rules both sides share.
 *
 * The command API is the text a command reads and the JSON it writes. The first half is declared
 * (`CmdSpec`); this is the second. The UI and modules import these instead of restating a shape,
 * and each command checks its answer against them, so a changed field is a type error on both
 * sides rather than a page that breaks.
 *
 * Everything under `src/lib/api/` imports only other import-free files, on purpose: browser code
 * imports this, and must not type-check core to do it.
 */

export * from './ids.ts';
export * from './system.ts';
export * from './share.ts';
export * from './pipeline.ts';
export * from './docs.ts';
export * from './events.ts';
export * from './comments.ts';
export * from './streams.ts';
export * from './users.ts';
export * from './audit.ts';
export * from './ssh.ts';
export type { ConfigEntry, ConfigOption, ConfigScope, ConfigSource, ConfigType } from '../config/types.ts';
export * from './search.ts';
export * from './similar.ts';
export * from './stars.ts';
export * from './feeds.ts';
export * from './completion.ts';
export * from './trash.ts';
export * from './position.ts';
export * from './node.ts';
export * from './relation.ts';
export * from './models.ts';
export type { Kind } from '../kinds/vocabulary.ts';
export type { ArgCompleteType, CmdArgDef, CmdEffect, CmdFlagDef, CmdSpec, FlagCompleteType } from '../../managers/exec/spec.ts';
export type { ContainerListing, ContainerMember } from '../containers/types.ts';
export type { SubjectEntry, SubjectListing, SubjectMatch, SubjectsOf } from '../subjects/types.ts';
export type { EnvVarDoc, EnvVarKind, NodeTypeCategory, NodeTypeDoc, Owned } from '../reference/types.ts';
