import { assertEquals } from '@std/assert';
import { PipelineEngine } from '../engine.ts';
import type { PipelineDef } from '../types.ts';
import type { PoolJob } from '../../../registries/pool/mod.ts';

type ClaimRequest = { kinds?: string[] };
type EngineInternals = {
  definitions: Map<string, PipelineDef>;
  advanceLocks: Map<string, unknown>;
  creatingByPipeline: Map<string, number>;
  entryAdmissionPercent: number;
  triggerCursor: number;
  claimTriggerFairly(): Promise<PoolJob | null>;
};

function definition(name: string, entryPoint = false): PipelineDef {
  return {
    name,
    triggers: [{ on: ['test.fact'] }],
    steps: { noop: { command: 'true' } },
    options: entryPoint ? { entryPoint: true } : undefined,
  };
}

function fixture(percent: number, counts: Partial<Record<'normal-a' | 'normal-b' | 'entry', number>> = {}) {
  const available = new Map([
    ['normal-a', counts['normal-a'] ?? 20],
    ['normal-b', counts['normal-b'] ?? 20],
    ['entry', counts.entry ?? 20],
  ]);
  let id = 0;
  const vfs = {
    poolClaim(_access: unknown, _path: string, request: ClaimRequest): Promise<PoolJob | null> {
      const kinds = request.kinds ?? [...available.keys()];
      for (const kind of kinds) {
        const count = available.get(kind) ?? 0;
        if (count > 0) {
          available.set(kind, count - 1);
          return Promise.resolve({ id: ++id, kind } as PoolJob);
        }
      }
      return Promise.resolve(null);
    },
  };
  const engine = new PipelineEngine(vfs as never, {} as never) as unknown as EngineInternals;
  engine.definitions = new Map([
    ['normal-a', definition('normal-a')],
    ['normal-b', definition('normal-b')],
    ['entry', definition('entry', true)],
  ]);
  engine.entryAdmissionPercent = percent;
  return engine;
}

Deno.test('entry admission reserves three of five claims while ordinary claims stay fair', async () => {
  const engine = fixture(60);
  const kinds: string[] = [];
  for (let i = 0; i < 5; i++) kinds.push((await engine.claimTriggerFairly())!.kind);

  assertEquals(kinds, ['normal-a', 'entry', 'normal-b', 'entry', 'entry']);
});

Deno.test('zero entry admission retains the original all-pipeline rotation', async () => {
  const engine = fixture(0);
  const kinds: string[] = [];
  for (let i = 0; i < 3; i++) kinds.push((await engine.claimTriggerFairly())!.kind);

  assertEquals(kinds, ['normal-a', 'normal-b', 'entry']);
});

Deno.test('admission gives the next slot to the pipeline with fewer open instances', async () => {
  const engine = fixture(0);
  engine.advanceLocks = new Map([
    ['/var/pipelines/instances/normal-a/a', {}],
    ['/var/pipelines/instances/normal-a/b', {}],
    ['/var/pipelines/instances/normal-a/c', {}],
    ['/var/pipelines/instances/entry/a', {}],
  ]);

  assertEquals((await engine.claimTriggerFairly())!.kind, 'normal-b');
});

Deno.test('the unfiltered cleanup probe cannot bypass a less-loaded ready pipeline', async () => {
  const engine = fixture(0);
  engine.triggerCursor = 3; // the wildcard's turn in the four-candidate rotation
  engine.advanceLocks = new Map([
    ['/var/pipelines/instances/normal-a/a', {}],
    ['/var/pipelines/instances/normal-a/b', {}],
  ]);

  assertEquals((await engine.claimTriggerFairly())!.kind, 'normal-b');
});

Deno.test('one ready pipeline may borrow the otherwise idle admission ceiling', async () => {
  const engine = fixture(0, { 'normal-b': 0, entry: 0 });
  engine.advanceLocks = new Map([
    ['/var/pipelines/instances/normal-a/a', {}],
    ['/var/pipelines/instances/normal-a/b', {}],
  ]);

  assertEquals((await engine.claimTriggerFairly())!.kind, 'normal-a');
});

Deno.test('in-progress trigger creation counts against pipeline admission load', async () => {
  const engine = fixture(0);
  engine.creatingByPipeline.set('normal-a', 1);

  assertEquals((await engine.claimTriggerFairly())!.kind, 'normal-b');
});

Deno.test('entry reservation also chooses its least-loaded entry pipeline', async () => {
  const engine = fixture(100);
  engine.definitions.get('normal-b')!.options = { entryPoint: true };
  engine.advanceLocks = new Map([
    ['/var/pipelines/instances/entry/a', {}],
    ['/var/pipelines/instances/entry/b', {}],
  ]);

  assertEquals((await engine.claimTriggerFairly())!.kind, 'normal-b');
});

Deno.test('an empty entry reservation falls back to normal fair admission', async () => {
  const engine = fixture(100);
  engine.definitions.delete('entry');
  const kinds: string[] = [];
  for (let i = 0; i < 2; i++) kinds.push((await engine.claimTriggerFairly())!.kind);

  assertEquals(kinds, ['normal-a', 'normal-b']);
});
