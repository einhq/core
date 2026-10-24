/**
 * What a container command answers `search --under` with. See `registry.ts`.
 *
 * Imports nothing, on purpose: these are part of the module contract (`@ein/client`), and
 * everything a contract type imports ships with the contract.
 */

/**
 * One member, as a container command answers for it (`JSON_OUTPUT=1 <command> <path>`).
 *
 * The module that registers a container command answers in this shape, whatever its rules are.
 */
export type ContainerMember = {
  /** The file: its identity, and what every enrichment reads. */
  path: string;
  /** The link inside the container, when membership is a link rather than the file living there. */
  memberPath?: string;
  /** The file's node id. */
  id: string;
  /**
   * The member that stands for this one where the container folds several onto one (a stack of
   * similar photos): its `path`. Absent for a member that stands for itself.
   */
  front?: string;
  /** On a member others fold onto: how many members the group has, itself included. */
  stackCount?: number;
};

/** A container command's whole answer. */
export type ContainerListing = {
  members: ContainerMember[];
  /** Members beyond the command's own ceiling exist and were not listed. */
  truncated: boolean;
};
