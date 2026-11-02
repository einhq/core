/** A track's tracker link, as `track-token` answers. */
export type TrackToken = {
  /** The track's path. */
  track: string;
  /** Whether a phone or GPS tracker may post fixes to the track at its link. */
  enabled: boolean;
  /** The link's path on this site, `/tracker/<track id>.<token>`; absent while turned off. */
  path?: string;
  /** When the current link was made, in epoch ms; absent while turned off. */
  createdAt?: number;
};
