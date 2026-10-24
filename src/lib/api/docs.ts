import type { EnvVarDoc, NodeTypeCategory, Owned } from '../reference/types.ts';
import type { CmdSpec } from '../../managers/exec/spec.ts';

export type EnvReference = Owned<EnvVarDoc> & {
  /** Its value in the calling shell; never given for `deployment`, whose values are not a shell's. */
  value?: string;
  /** Set in the calling shell but described nowhere. */
  undescribed?: true;
};

export type NodeTypeReference = {
  type: string;
  label?: string;
  description?: string;
  category?: NodeTypeCategory;
  owner?: string;
  /** How many nodes of the type exist, readable or not: the store counts, not the reader. */
  count: number;
};

/** `docs commands`: one command on the caller's PATH, its whole spec and whose it is. */
export type ListedCommand = { name: string; module: string; spec: CmdSpec };

/**
 * `docs find`: commands by what they do, best first — from the command `CFG_COMMAND_FINDER` names
 * (the assistant's index: by meaning when EMS can embed, else by words), or core's own match on
 * their names and descriptions when it names none.
 */
export type CommandHit = { name: string; description?: string; effect?: 'read' | 'write'; score: number };
export type CommandFind = { hits: CommandHit[] };
