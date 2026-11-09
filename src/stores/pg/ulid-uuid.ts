/**
 * A ULID kept as a PostgreSQL `uuid`: the same 128 bits, 16 bytes instead of 26 characters.
 * `uuid` values compare byte by byte, so they sort as the ULIDs do, and the first 48 bits are
 * still the ULID's milliseconds.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VALUES = new Map([...CROCKFORD].map((char, value) => [char, value]));

/** `01ARZ3NDEKTSV4RRFFQ69G5FAV` → `01563e3a-b5d3-d676-4c61-efb99302bd5b`. Throws on anything not a ULID. */
export function ulidToUuid(ulid: string): string {
  if (ulid.length !== 26) throw new Error(`not a ulid: ${ulid}`);
  let bits = 0n;
  for (const char of ulid.toUpperCase()) {
    const value = VALUES.get(char);
    if (value === undefined) throw new Error(`not a ulid: ${ulid}`);
    bits = (bits << 5n) | BigInt(value);
  }
  if (bits >> 128n) throw new Error(`not a ulid: ${ulid}`);
  const hex = bits.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The inverse of {@link ulidToUuid}. */
export function uuidToUlid(uuid: string): string {
  let bits = BigInt(`0x${uuid.replaceAll('-', '')}`);
  let ulid = '';
  for (let i = 0; i < 26; i++) {
    ulid = CROCKFORD[Number(bits & 31n)] + ulid;
    bits >>= 5n;
  }
  return ulid;
}

/** The smallest id of millisecond `ms`, as a `uuid`: a bound for "written at or after `ms`". */
export function uuidAtTime(ms: number): string {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The milliseconds a `uuid`-kept ULID was minted at. */
export const uuidTime = (uuid: string): number => parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
