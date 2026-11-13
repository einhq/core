/**
 * The rendition table as read from `/etc/renditions.yaml` (`RENDITIONS_PATH`): for the commands that
 * make renditions, and for `renditions`, which answers it to the shell's pages.
 *
 * Read as the administrator, since every viewer's pages need it and it says nothing private. An
 * entry the file gets wrong is left out with a warning, so a mistake costs that role and not every
 * rendition. No file is no renditions: an installation whose modules make none.
 */

import { toText } from '@std/streams/to-text';
import { parse } from '@std/yaml';
import { ADMIN_ACCESS } from '../access/constants.ts';
import {
  type AudioRendition,
  type ImageRendition,
  NO_RENDITIONS,
  type RenditionKind,
  type RenditionTable,
  type StoryboardRendition,
  type VideoRendition,
} from '../api/renditions.ts';
import { RENDITIONS_PATH } from '../paths.ts';
import { NodeNotFoundError } from '../../vfs/errors.ts';
import type { ModuleVFS } from '../../vfs/node-vfs.ts';

/** A table, and what was wrong in the file it was read from. */
export type RenditionTableRead = { table: RenditionTable; warnings: string[] };

const KINDS: RenditionKind[] = ['photo', 'video', 'audio', 'document'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPositive = (value: unknown): value is number => isNumber(value) && value > 0;

/** An entry read as a rendition, or what is wrong with it. */
type Reader<T> = (value: Record<string, unknown>) => T | string;

const readImage: Reader<ImageRendition> = (value) => {
  if (!isPositive(value.width) || !isPositive(value.height)) return 'needs a width and a height above 0';
  if (value.fit !== 'cover' && value.fit !== 'contain') return 'needs fit: cover or contain';
  if (!isNumber(value.quality)) return 'needs a quality';
  const kinds = value.kinds ?? KINDS;
  if (!Array.isArray(kinds) || kinds.some((kind) => !KINDS.includes(kind))) return `kinds must be a list of ${KINDS.join(', ')}`;
  return { width: value.width, height: value.height, fit: value.fit, quality: value.quality, kinds: [...kinds] };
};

const readVideo: Reader<VideoRendition> = (value) => {
  if (!isPositive(value.width) || !isPositive(value.height)) return 'needs a width and a height above 0';
  if (!isNumber(value.crf) || !isNumber(value.preset)) return 'needs a crf and a preset';
  if (value.audioBitrate !== undefined && typeof value.audioBitrate !== 'string') return 'audioBitrate must be text, such as 128k';
  if ((value.start !== undefined && !isNumber(value.start)) || (value.seconds !== undefined && !isPositive(value.seconds))) {
    return 'start and seconds must be numbers of seconds';
  }
  return {
    width: value.width,
    height: value.height,
    crf: value.crf,
    preset: value.preset,
    ...(typeof value.audioBitrate === 'string' ? { audioBitrate: value.audioBitrate } : {}),
    ...(isNumber(value.start) ? { start: value.start } : {}),
    ...(isPositive(value.seconds) ? { seconds: value.seconds } : {}),
    ...(value.mute === true ? { mute: true } : {}),
  };
};

const readAudio: Reader<AudioRendition> = (value) => {
  if (typeof value.bitrate !== 'string' || !isPositive(value.sampleRate)) return 'needs a bitrate, such as 128k, and a sampleRate';
  return { bitrate: value.bitrate, sampleRate: value.sampleRate };
};

const readStoryboard: Reader<StoryboardRendition> = (value) => {
  const { tile, columns, maxTiles, minInterval, quality } = value;
  if (!isPositive(tile) || !isPositive(columns) || !isPositive(maxTiles) || !isPositive(minInterval) || !isNumber(quality)) {
    return 'needs a tile, columns, maxTiles and minInterval above 0, and a quality';
  }
  return { tile, columns, maxTiles, minInterval, quality };
};

/** The table `text` holds, leaving out what it gets wrong, with a warning for each. */
export const parseRenditionTable = (text: string): RenditionTableRead => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { table: NO_RENDITIONS, warnings: [`not YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (raw === null || raw === undefined) return { table: NO_RENDITIONS, warnings: [] };
  if (!isRecord(raw)) return { table: NO_RENDITIONS, warnings: ['not a table of renditions'] };

  const warnings: string[] = [];
  const roles = <T>(section: string, read: Reader<T>): Record<string, T> => {
    const entries = raw[section];
    if (entries === undefined || entries === null) return {};
    if (!isRecord(entries)) {
      warnings.push(`${section}: not a list of roles`);
      return {};
    }
    const found: Record<string, T> = {};
    for (const [role, value] of Object.entries(entries)) {
      const rendition = isRecord(value) ? read(value) : 'is not a list of settings';
      if (typeof rendition === 'string') warnings.push(`${section}.${role}: ${rendition}`);
      else found[role] = rendition;
    }
    return found;
  };

  const table: RenditionTable = { image: roles('image', readImage), video: roles('video', readVideo), audio: roles('audio', readAudio) };
  if (raw.storyboard !== undefined && raw.storyboard !== null) {
    const storyboard = isRecord(raw.storyboard) ? readStoryboard(raw.storyboard) : 'is not a list of settings';
    if (typeof storyboard === 'string') warnings.push(`storyboard: ${storyboard}`);
    else table.storyboard = storyboard;
  }
  return { table, warnings };
};

/** The table in `/etc/renditions.yaml`, read fresh: no renditions when there is no file. */
export const readRenditionTable = async (vfs: ModuleVFS): Promise<RenditionTableRead> => {
  let handle;
  try {
    handle = await vfs.open(ADMIN_ACCESS, RENDITIONS_PATH, { mode: 'r' });
  } catch (error) {
    if (error instanceof NodeNotFoundError) return { table: NO_RENDITIONS, warnings: [] };
    throw error;
  }
  try {
    return parseRenditionTable(await toText(handle.readable));
  } finally {
    await handle.close();
  }
};
