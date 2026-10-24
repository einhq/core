import type { NodeOwnership, SearchLayoutIndex } from '@ein/api';
export type { LayoutIndexRow as SearchLayoutRow, SearchLayoutIndex } from '@ein/api';

type DecodedLayoutItem = {
  path: string;
  memberPath?: string;
  kind: 'photo' | 'video' | 'audio';
  type: 'file';
  name: string;
  mimetype?: string;
  takenAt?: string;
  score: number;
  width?: number;
  height?: number;
  angle?: number;
  duration?: number;
  stackCount?: number;
  sar?: number;
  ownership: NodeOwnership;
  pinned?: true;
  /** Present only when the layout was asked for it (`--fields derivatives`). */
  hasDerivatives?: boolean;
};

const KINDS = ['photo', 'video', 'audio'] as const;
const joinPath = (directory: string, name: string) => directory === '/' ? `/${name}` : `${directory}/${name}`;
const positive = (value: number): number | undefined => value > 0 ? value : undefined;

/**
 * The rows of a compact layout as items. A trailing column the decoder does not know is ignored,
 * and `derivatives`, the list beside the rows, sets `hasDerivatives` when the answer carries it.
 */
export function decodeSearchLayout(index: SearchLayoutIndex): DecodedLayoutItem[] {
  return index.items.map((row, position) => {
    const [pathDir, basename, memberDir, memberName, displayName, kindCode, mimetypeIndex, takenAt, width, height, angle, duration, stackCount, sar, ownershipIndex, pinned] =
      row;
    const directory = index.directories[pathDir];
    const kind = KINDS[kindCode];
    const mimetype = index.mimetypes[mimetypeIndex];
    const ownership = index.ownerships[ownershipIndex];
    if (directory === undefined || kind === undefined || mimetype === undefined || ownership === undefined) {
      throw new Error('invalid search layout dictionary index');
    }

    const memberDirectory = memberDir < 0 ? undefined : index.directories[memberDir];
    if (memberDir >= 0 && memberDirectory === undefined) {
      throw new Error('invalid search layout member directory index');
    }

    return {
      path: joinPath(directory, basename),
      memberPath: memberDirectory ? joinPath(memberDirectory, memberName) : undefined,
      kind,
      type: 'file',
      name: displayName || basename,
      mimetype: mimetype || undefined,
      takenAt: takenAt || undefined,
      score: 1,
      width: positive(width),
      height: positive(height),
      angle: angle || undefined,
      duration: positive(duration),
      stackCount: positive(stackCount),
      sar: positive(sar),
      ownership,
      pinned: pinned === 1 || undefined,
      ...(index.derivatives ? { hasDerivatives: index.derivatives[position] === 1 } : {}),
    };
  });
}
