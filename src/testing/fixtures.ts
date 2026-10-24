/**
 * Test Fixtures
 *
 * Provides helpers for setting up test data.
 */

import type { ShellClient } from './shell-client.ts';
import { isCaptureTime, toUtc } from '../lib/capture-time/mod.ts';
import { SYSTEM_TIME_ZONE } from '../lib/datetime/mod.ts';

export type DirectorySetup = {
  path: string;
  children?: (DirectorySetup | FileSetup)[];
};

export type FileSetup = {
  path: string;
  content?: string;
};

/**
 * Create a directory structure for testing
 */
export async function setupDirectories(
  client: ShellClient,
  structure: DirectorySetup,
): Promise<void> {
  await client.exec(`mkdir -p ${structure.path}`);

  if (structure.children) {
    for (const child of structure.children) {
      if ('children' in child) {
        await setupDirectories(client, child as DirectorySetup);
      } else {
        const file = child as FileSetup;
        await client.exec(`mkfile ${file.path}`);
        if (file.content) {
          const escapedContent = file.content.replace(/"/g, '\\"');
          await client.exec(`echo "${escapedContent}" > ${file.path}`);
        }
      }
    }
  }
}

/**
 * Create a simple test directory with common files
 */
export async function setupBasicTestDir(client: ShellClient, basePath = '/test'): Promise<void> {
  await setupDirectories(client, {
    path: basePath,
    children: [
      { path: `${basePath}/dir1`, children: [] },
      { path: `${basePath}/dir2`, children: [] },
      { path: `${basePath}/file1.txt`, content: 'Hello World' },
      { path: `${basePath}/file2.txt`, content: 'Test content' },
    ],
  });
}

/**
 * Create a nested directory structure for testing path operations
 */
export async function setupNestedDirs(client: ShellClient, basePath = '/test'): Promise<void> {
  await setupDirectories(client, {
    path: basePath,
    children: [
      {
        path: `${basePath}/a`,
        children: [
          {
            path: `${basePath}/a/b`,
            children: [
              { path: `${basePath}/a/b/c`, children: [] },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Common test directory structures
 */
export const fixtures = {
  basicFileSystem: {
    path: '/test',
    children: [
      { path: '/test/dir1', children: [] },
      { path: '/test/dir2', children: [] },
      { path: '/test/file1.txt', content: 'Hello World' },
      { path: '/test/file2.txt', content: 'Test content' },
    ],
  } satisfies DirectorySetup,

  nestedStructure: {
    path: '/test',
    children: [
      {
        path: '/test/a',
        children: [
          {
            path: '/test/a/b',
            children: [
              { path: '/test/a/b/c', children: [] },
            ],
          },
        ],
      },
    ],
  } satisfies DirectorySetup,

  withHiddenFiles: {
    path: '/test',
    children: [
      { path: '/test/.hidden', content: 'hidden content' },
      { path: '/test/visible.txt', content: 'visible content' },
    ],
  } satisfies DirectorySetup,
};

/**
 * The capture-time attrs a real writer would leave on a media node, from one wall clock.
 *
 * A fixture that sets `takenAt` by hand and stops there produces a file the *search* cannot
 * order, because ordering is on `takenAtUtc` and `orderBy` drops rows that have none — the
 * failure looks like an empty result rather than an error. Rather than have every fixture
 * remember the pair, this does what media's resolver does with a manual time: the wall clock
 * as given, its instant in the archive's zone, `manual` as the source.
 *
 * Wall clocks with no offset are read in the archive's own zone, so a test asserting on
 * `takenAtUtc` must go through this rather than hard-code an instant, or it will pass in one
 * `TZ` and fail in another.
 */
export const captureTime = (wallClock: string): Record<string, unknown> => {
  const takenAtUtc = isCaptureTime(wallClock) ? toUtc(wallClock, SYSTEM_TIME_ZONE) : undefined;
  // A value the resolver refuses — a zeroed clock, a year before photography — deliberately
  // yields the wall clock and no instant, which is exactly the state such a file is in on disk
  // and what the tests that use those values are about.
  return takenAtUtc ? { takenAt: wallClock, takenAtUtc, takenAtSource: 'manual' } : { takenAt: wallClock };
};
