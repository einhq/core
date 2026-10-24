import type { NodeTreeSpec } from '../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import type { PipelineDef, PipelineInstanceAttrs, PipelineStep, PipelineStepAttrs } from './types.ts';

/** Attempts a step gets when neither the step nor the pipeline says otherwise. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Build the attrs for a fresh step node.
 *
 * Instances are created from two locations — the engine's own trigger path and
 * `pipeline start` — and every per-step field a definition can carry has to
 * survive both, so both go through here.
 */
function stepAttrs(stepName: string, step: PipelineStep, maxAttempts?: number): PipelineStepAttrs {
  return {
    stepName,
    status: 'pending',
    dependsOn: step.dependsOn ?? [],
    command: step.command,
    condition: step.condition,
    pool: step.pool,
    kind: step.kind,
    requires: step.requires,
    priority: step.priority,
    exclusive: step.exclusive,
    attempts: 0,
    maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
}

/**
 * The whole instance as one tree: the instance node, its `steps/` directory and
 * a node per step.
 *
 * Written in one transaction (`vfs.createTree`), which is what keeps the
 * instance's own `created` event from reaching the engine before the steps it
 * has to advance exist. It also keeps the two creation paths — the engine's
 * trigger and `pipeline start` — building the same shape, for the same reason
 * `stepAttrs` is shared.
 */
export function instanceTree(instanceId: string, attrs: PipelineInstanceAttrs, def: PipelineDef): NodeTreeSpec {
  return {
    type: NODE_TYPE_DIRECTORY,
    name: instanceId,
    attrs,
    children: [{
      type: NODE_TYPE_DIRECTORY,
      name: 'steps',
      children: Object.entries(def.steps).map(([stepName, step]) => ({
        type: NODE_TYPE_DIRECTORY,
        name: stepName,
        attrs: stepAttrs(stepName, step, def.options?.maxAttempts),
      })),
    }],
  };
}
