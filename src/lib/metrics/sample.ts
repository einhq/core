/** A log entry paired with the time it was written. Its own file so reading a series (`read.ts`) reaches nothing else. */
export type Sample<T> = { at: number; value: T };
