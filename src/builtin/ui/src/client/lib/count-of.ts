import { formatCount } from './format.ts';

/** `1 album`, `3,611 albums`: the count as a header says it (`formatCount`) and the noun that agrees with it. */
export const countOf = (count: number, one: string, many: string): string => `${formatCount(count)} ${count === 1 ? one : many}`;
