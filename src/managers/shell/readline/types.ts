import type { LineEditor, TabCompletion } from '@ein/bash-executor';
import { ResourceHandleIf } from '../../../registries/types.ts';

export type EchoMode = 'default' | 'secret' | 'none';

export type ReadlineIO = {
  in: AsyncGenerator<string | null, void, unknown>;
  out: WritableStreamDefaultWriter<string>;
};

export type ReadlineOptions = {
  in: ResourceHandleIf;
  out: ResourceHandleIf;
  echoMode?: EchoMode;
  /** The shell's line editor, with its history and the keys typed ahead; a prompt of its own has none */
  editor?: LineEditor;
  rows: number;
  cols: number;
  /** A Tab: what it does to the line, the shell's completion deciding (`AstExecutor.completeTab`) */
  onTab?: (line: string, point: number, list: boolean) => Promise<TabCompletion>;
};
