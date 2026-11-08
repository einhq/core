/** A log entry paired with the time it was written. Its own file so reading a series (`read.ts`) reaches nothing else. */
export type Sample<T> = { at: number; value: T };

/** One interval of a bucketed read: where it starts, the entries' value summed up, and how many there were. */
export type BucketSample = { at: number; value: number | null; count: number };
