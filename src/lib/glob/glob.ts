/**
 * Glob pattern utilities for matching filenames and paths.
 *
 * Supports:
 * - `*` - Match any characters (zero or more)
 * - `?` - Match single character
 * - `[abc]` - Match any character in set
 * - `[a-z]` - Match character range
 * - `[!abc]` or `[^abc]` - Match any character NOT in set
 *
 * With `pathname`, no wildcard matches `/` and `**` matches any characters, `/` included.
 */

interface GlobOptions {
  /** `*`, `?` and `[…]` stop at `/`; `**` crosses it. */
  pathname?: boolean;
}

/**
 * Convert a glob pattern to a RegExp.
 */
export function globToRegex(pattern: string, opts: GlobOptions = {}): RegExp {
  const any = opts.pathname ? '[^/]' : '.';
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*' && opts.pathname && pattern[i + 1] === '*') {
      regex += '.*';
      i++;
    } else if (char === '*') {
      regex += `${any}*`;
    } else if (char === '?') {
      regex += any;
    } else if (char === '[') {
      // Handle character class
      let j = i + 1;
      let classContent = '';
      let negated = false;

      // Check for negation
      if (pattern[j] === '!' || pattern[j] === '^') {
        negated = true;
        j++;
      }

      // Find closing bracket
      while (j < pattern.length && pattern[j] !== ']') {
        classContent += pattern[j];
        j++;
      }

      if (pattern[j] === ']') {
        regex += negated ? `[^${opts.pathname ? '/' : ''}${classContent}]` : `[${classContent}]`;
        i = j;
      } else {
        // No closing bracket, treat as literal
        regex += '\\[';
      }
    } else if ('.+^${}()|\\'.includes(char)) {
      // Escape regex special chars (not including [ which is handled above)
      regex += '\\' + char;
    } else {
      regex += char;
    }
    i++;
  }

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a string contains glob metacharacters.
 */
export function hasGlobChars(text: string): boolean {
  return /[*?\[]/.test(text);
}
