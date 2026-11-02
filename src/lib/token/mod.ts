/**
 * Secrets a URL carries in place of a signed-in session: a share link's token, a tracker's.
 */

/** What a token is made of: letters and digits only, so it is safe in a URL and is never read as a flag. */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 22 characters of 62: 130 random bits. */
const TOKEN_LENGTH = 22;

const TOKEN_PATTERN = /^[A-Za-z0-9]{22}$/;

/** A fresh token. */
export const newToken = (): string => {
  let token = '';
  while (token.length < TOKEN_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 is four times 62: a byte above it would make the first letters likelier than the rest.
      if (byte < 248 && token.length < TOKEN_LENGTH) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
    }
  }
  return token;
};

/** Whether `token` could be one `newToken` made, before anything is looked up by it. */
export const isToken = (token: string): boolean => TOKEN_PATTERN.test(token);

/** Whether two tokens are the same, in time that does not depend on where they differ. */
export const sameToken = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
