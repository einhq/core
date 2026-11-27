import { currentUiManifest } from '../signals/module-ui.ts';

/**
 * Start one of a module's Web Workers, by the module's name and the worker's (`mod.json`
 * `ui.workers`), from its script in the UI build: a dedicated worker of type `module`, which may
 * `import()` scripts and `fetch` or read files from EiN with the reader's session, and compile
 * WebAssembly. Throws when the module has no such worker, or no build of it is loaded.
 */
export const moduleWorker = (module: string, name: string, options?: Omit<WorkerOptions, 'type'>): Worker => {
  const entry = currentUiManifest()?.modules[module];
  const url = entry?.workers?.[name];
  if (!url) {
    const known = Object.keys(entry?.workers ?? {});
    throw new Error(
      entry
        ? `module ${module} has no worker '${name}'${known.length ? `; it has ${known.join(', ')}` : ''}: name it in mod.json ui.workers and run ui-build`
        : `module ${module} has no UI loaded`,
    );
  }
  return new Worker(url, { ...options, type: 'module' });
};
