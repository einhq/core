import { ulid } from '@std/ulid';

/**
 * Identity of this process run.
 *
 * Nodes that only make sense while the process that made them is alive — tty
 * nodes, and the sessions bound to an SSH channel or a WebSocket — carry this
 * value. A stamp that is not `BOOT_ID` means the owning process is gone, which
 * is the one thing a sweep cannot work out from timestamps: a tty is either
 * live in *this* process or it is garbage, no matter how recently it was
 * touched.
 */
export const BOOT_ID = ulid();
