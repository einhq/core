/**
 * A relation link's attrs: one half of the pair of softlinks `relate` makes under each node's
 * `relations/` directory. `peerLink` is the other half's own path, so a half can be found from its
 * peer, and a move re-points it as it re-points the softlink.
 */
export type RelationAttrs = {
  relation?: {
    label: string;
    peerLink: string;
  };
};
