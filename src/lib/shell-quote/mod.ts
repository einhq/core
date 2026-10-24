/**
 * Quote a string for safe use as a single argument in a shell command line.
 *
 * `#!ts` bins and the pipeline engine build command *strings* that the
 * bash-executor re-parses, so any value with spaces (or `$`, quotes, backticks,
 * …) must be quoted or it word-splits. Wrap in single quotes and escape embedded
 * single quotes with the POSIX `'\''` idiom — everything else is literal inside
 * single quotes.
 */
export const shq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
