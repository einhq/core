/**
 * The supervisor's answers, as `supervisor status` passes them on: the services beside EiN, which
 * the supervisor installs and updates when EiN asks (`CFG_SUPERVISOR_URL`).
 */

/** What the installed modules ask of a service: the newest line any asks for, and each one's range. */
export type ServiceWanted = {
  /** The image line that range is held to: `0.4` for `^0.4.4`, `1` for `^1.2.0`. */
  line: string;
  modules: { module: string; range: string }[];
};

/** One service beside EiN. */
export type SupervisedService = {
  /** Its name in the installation: core, db, ems, llm, devices, supervisor, or one a module names. */
  name: string;
  /** What it is, as a sentence names it: `the media service`. */
  title: string;
  /** Installed on request (the media service, the language model, the devices sidecar), not always. */
  optional: boolean;
  installed: boolean;
  /** What it is given beyond an ordinary container, which installing it says first. */
  gives: string[];
  /** What installing it fetches. */
  size?: string;
  /** The line of its image it runs at, `main` before a module asks for one. */
  line?: string;
  wanted?: ServiceWanted;
  /** Its container's state (`running`, `exited`…), when it has one. */
  state?: string;
  /** Its health check's verdict (`healthy`, `starting`, `unhealthy`), when it has one. */
  health?: string;
  /** When its container started. */
  since?: string;
  /** The image its container runs. */
  image?: string;
  /** The version of its interface that image states (its `eu.einhq.api` label). */
  version?: string;
  /** When that image was built. */
  built?: string;
  /** A service a module names that the supervisor does not know, and so cannot install. */
  unknown?: boolean;
};

/** An install or update the supervisor runs, or the last one it ran. */
export type SupervisorJob = {
  id: string;
  /** The options of the setup.sh it runs: `--ems`, `--only core,db`. */
  args: string[];
  /** Who asked: a user's name, or the supervisor itself for a nightly or a module's update. */
  by: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** The last lines of its output. */
  lines: string[];
};

/** `supervisor status`. */
export type SupervisorStatus = {
  /** Whether this installation has a supervisor: without one, setup.sh installs and updates the services. */
  configured: boolean;
  /** Why the supervisor did not answer. */
  error?: string;
  version?: string;
  /** The container engine, `podman` or `docker`. */
  engine?: string;
  /** When every service is updated each night, `HH:MM` in the machine's time; null for never. */
  updateAt?: string | null;
  services: SupervisedService[];
  job: SupervisorJob | null;
};
