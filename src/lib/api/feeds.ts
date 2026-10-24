/**
 * `news`, `events` and `onthisday`: what the modules have to tell about lately, about the days
 * around a date, and about one calendar day in earlier years. Core knows none of it. Each gathers
 * the answers of every command on `PATH` named after it with a dash (`news-*`, `events-*`,
 * `onthisday-*`), each a provider answering a list of entries in the shape below without `source`
 * (`Provided`), then orders the whole list and cuts it to the limit.
 *
 * Every entry has a `title`, one line saying what it is (what a terminal prints for it, and what a
 * reader hears for it), and a `route`: the providing module's route that draws it, whose query
 * carries what it draws, so the page around it asks nothing more and names no module. `source` is
 * the provider it came from, its command's name after the dash (`albums` for `news-albums`).
 * `path`, when there is one, is the node the entry is about, for a reader of the answer to open:
 * the route is the page's, not a node.
 */

/** The account a piece of news is put down to. */
export type FeedActor = {
  uid: number;
  username: string;
  /** The account's own name, when it has one. */
  name?: string;
};

/** `news`: something added lately. The answer is newest first. */
export type NewsEntry = {
  title: string;
  route: string;
  source: string;
  path?: string;
  /** Epoch ms it happened. */
  at: number;
  /** Who did it, when an account did. */
  by?: FeedActor;
  /** A Tabler icon name for the entry, drawn where no account's portrait is. */
  icon?: string;
};

/**
 * `events`: something falling on a day near the one asked about. The limit keeps milestones
 * first, then the nearest; the answer is in date order.
 */
export type EventEntry = {
  title: string;
  route: string;
  source: string;
  path?: string;
  /** The day it falls on, `YYYY-MM-DD`. */
  date: string;
  /** A round number or otherwise notable occasion, kept over ordinary ones when the limit cuts. */
  milestone?: boolean;
};

/** `onthisday`: something from the calendar day asked about, in an earlier year. The answer is newest year first. */
export type OnThisDayEntry = {
  title: string;
  route: string;
  source: string;
  path?: string;
  year: number;
};

/** What a provider answers: its entries without `source`, which the gathering command sets. */
export type Provided<T extends { source: string }> = Omit<T, 'source'>;
