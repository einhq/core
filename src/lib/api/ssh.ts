/** What the commands that reach other machines answer with. */

/** `ssh-keygen -l`: a key's fingerprint. */
export type SshKeyFingerprint = {
  bits: number;
  /** `SHA256:…` */
  fingerprint: string;
  comment: string;
  /** `ED25519`, `ECDSA`, `RSA` */
  type: string;
};

/** `ssh-keygen`: the key pair it made. */
export type SshKeyPairCreated = {
  ok: true;
  path: string;
  publicKeyPath: string;
  fingerprint: string;
};

/** `ssh-copy-id`: how many keys it added (0 when the key was already there). */
export type SshCopyIdResult = {
  ok: true;
  added: number;
};
