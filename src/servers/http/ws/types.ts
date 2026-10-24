/**
 * Types for WebSocket handlers
 */

import type { ExecutionManager } from '../../../managers/exec/mod.ts';
import type { BufferManagerIf } from '../../../managers/buffer/mod.ts';
import type { NodePath, NodeReference, NodeVFS } from '../../../vfs/mod.ts';

export type ShellWebSocketHandlerConfig = {
  cem: ExecutionManager;
  vfs: NodeVFS;
  bufferManager: BufferManagerIf;
  sessionPath: NodePath;
  env: Record<string, string>;
  /** The address of the client behind the socket. */
  from?: string;
};

// ===== WebSocket Message Types for Event Subscriptions =====

// Server to Client push messages (not part of request/response pattern)

// ===== WebSocket Message Types for VFS Operations =====

type DropFirst<T extends any[]> = T extends [any, ...infer Rest] ? Rest : never;

type ReplaceNodeRef<T> = T extends NodeReference ? NodePath : T;

type MapTuple<T extends readonly any[]> = {
  [K in keyof T]: ReplaceNodeRef<T[K]>;
};

type CopyArgs<T extends (...args: any) => any> = MapTuple<DropFirst<Parameters<T>>>;

export type VfsGetMessage = {
  type: 'vfs.get';
  id: string;
  params: CopyArgs<NodeVFS['get']>;
};

export type VfsChildrenMessage = {
  type: 'vfs.children';
  id: string;
  params: CopyArgs<NodeVFS['children']>;
};

export type VfsExistsMessage = {
  type: 'vfs.exists';
  id: string;
  params: CopyArgs<NodeVFS['exists']>;
};

export type VfsResolvePathMessage = {
  type: 'vfs.resolvePath';
  id: string;
  params: CopyArgs<NodeVFS['resolvePath']>;
};

export type VfsResolveIdMessage = {
  type: 'vfs.resolveId';
  id: string;
  params: CopyArgs<NodeVFS['resolveId']>;
};

export type VfsCreateMessage = {
  type: 'vfs.create';
  id: string;
  params: CopyArgs<NodeVFS['create']>;
};

export type VfsEnsureMessage = {
  type: 'vfs.ensure';
  id: string;
  params: CopyArgs<NodeVFS['ensure']>;
};

export type VfsUpdateMessage = {
  type: 'vfs.update';
  id: string;
  params: CopyArgs<NodeVFS['update']>;
};

export type VfsRenameMessage = {
  type: 'vfs.rename';
  id: string;
  params: CopyArgs<NodeVFS['rename']>;
};

export type VfsLinkMessage = {
  type: 'vfs.link';
  id: string;
  params: CopyArgs<NodeVFS['link']>;
};

export type VfsUnlinkMessage = {
  type: 'vfs.unlink';
  id: string;
  params: CopyArgs<NodeVFS['unlink']>;
};

export type VfsCopyMessage = {
  type: 'vfs.copy';
  id: string;
  params: CopyArgs<NodeVFS['copy']>;
};

// Response messages
