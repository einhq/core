/**
 * Answer "what is holding these objects alive?" for one class in a .heapsnapshot.
 *
 * `heap-top.ts` says what a heap is made of and what grew; this says who is keeping it. That
 * is the difference between "4,498 Pipes leaked" and "4,498 Pipes are in BufferManager.pipes".
 *
 *   deno run -A scripts/heap-retainers.ts --class Pipe /files-tmp/heap/t1.heapsnapshot
 *   deno run -A scripts/heap-retainers.ts --class Cmd --depth 4 t1.heapsnapshot
 *
 * Output is the immediate retainers of the class, aggregated by retaining class and the edge
 * name they hold it under, then the same one level further up, to `--depth` levels.
 *
 * The whole snapshot is parsed into typed arrays first — a 225 MB snapshot is ~2.5M nodes and
 * ~10M edges, which fits in a few hundred MB that way and in nothing sane as JS objects.
 */

import { parseArgs } from '@std/cli/parse-args';

const flags = parseArgs(Deno.args, {
  boolean: ['path'],
  string: ['class', 'depth', 'top', 'sample', 'type'],
  // `object` by default: a class name also names its string, its ScopeInfo and its
  // SharedFunctionInfo, and walking those finds the code that declares the class rather than
  // whatever is holding the instances.
  default: { depth: '2', top: '12', sample: '2000', type: 'object' },
});

const path = flags._[0] as string | undefined;
const target = flags.class;

if (!path || !target) {
  console.error('usage: heap-retainers.ts --class <ClassName> [--depth N] [--top N] <file.heapsnapshot>');
  Deno.exit(2);
}

const depth = Number(flags.depth);
const top = Number(flags.top);
const sampleLimit = Number(flags.sample);

// ---- parse ---------------------------------------------------------------------------------

type Meta = {
  node_fields: string[];
  node_types: string[][];
  edge_fields: string[];
  edge_types: string[][];
};

const text = await readSections(path);

/**
 * Read the three sections we need. `nodes` and `edges` are flat integer arrays and `strings` is
 * an array of strings; everything else in the document is skipped.
 */
async function readSections(file: string): Promise<{
  meta: Meta;
  nodeCount: number;
  nodes: Int32Array;
  edges: Int32Array;
  strings: string[];
}> {
  const handle = await Deno.open(file, { read: true });
  const decoder = new TextDecoder();

  let phase: 'header' | 'nodes' | 'seek-edges' | 'edges' | 'seek-strings' | 'strings' | 'done' = 'header';
  let buffered = '';
  let meta: Meta | undefined;
  let nodeCount = 0;
  let edgeCount = 0;

  let nodes = new Int32Array(0);
  let edges = new Int32Array(0);
  const strings: string[] = [];

  let at = 0;
  let value = 0;
  let inNumber = false;

  // string scanner
  let inString = false;
  let escaped = false;
  let current = '';

  const scanInts = (chunk: string, into: Int32Array): number => {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);

      if (c >= 48 && c <= 57) {
        value = value * 10 + (c - 48);
        inNumber = true;
        continue;
      }

      if (inNumber) {
        if (at < into.length) into[at] = value;
        at += 1;
        value = 0;
        inNumber = false;
      }

      if (c === 93) return i + 1;
    }

    return -1;
  };

  for await (const buf of handle.readable) {
    buffered += decoder.decode(buf, { stream: true });

    if (phase === 'header') {
      const marker = buffered.indexOf('"nodes"');
      if (marker === -1) continue;

      const header = JSON.parse(buffered.slice(buffered.indexOf('{'), marker).replace(/,\s*$/, '') + '}');
      meta = header.snapshot.meta;
      nodeCount = header.snapshot.node_count;
      edgeCount = header.snapshot.edge_count;
      nodes = new Int32Array(nodeCount * meta!.node_fields.length);
      edges = new Int32Array(edgeCount * meta!.edge_fields.length);

      buffered = buffered.slice(buffered.indexOf('[', marker) + 1);
      phase = 'nodes';
      at = 0;
    }

    if (phase === 'nodes') {
      const end = scanInts(buffered, nodes);
      if (end === -1) {
        buffered = '';
        continue;
      }
      buffered = buffered.slice(end);
      phase = 'seek-edges';
    }

    if (phase === 'seek-edges') {
      const marker = buffered.indexOf('"edges"');
      if (marker === -1) {
        buffered = buffered.slice(-16);
        continue;
      }
      buffered = buffered.slice(buffered.indexOf('[', marker) + 1);
      phase = 'edges';
      at = 0;
    }

    if (phase === 'edges') {
      const end = scanInts(buffered, edges);
      if (end === -1) {
        buffered = '';
        continue;
      }
      buffered = buffered.slice(end);
      phase = 'seek-strings';
    }

    if (phase === 'seek-strings') {
      const marker = buffered.indexOf('"strings"');
      if (marker === -1) {
        buffered = buffered.slice(-16);
        continue;
      }
      buffered = buffered.slice(buffered.indexOf('[', marker) + 1);
      phase = 'strings';
    }

    if (phase === 'strings') {
      let consumed = 0;

      for (let i = 0; i < buffered.length; i++) {
        const ch = buffered[i];

        if (inString) {
          if (escaped) {
            current += ch;
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
            strings.push(current);
            current = '';
            consumed = i + 1;
          } else {
            current += ch;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          current = '';
        } else if (ch === ']') {
          phase = 'done';
          consumed = i + 1;
          break;
        }
      }

      buffered = inString ? '' : buffered.slice(consumed);
      if (phase === 'done') break;
    }
  }

  if (!meta) {
    console.error('could not read snapshot header — is this a .heapsnapshot?');
    Deno.exit(1);
  }

  return { meta, nodeCount, nodes, edges, strings };
}

const { meta, nodeCount, nodes, edges, strings } = text;

const nodeFieldCount = meta.node_fields.length;
const nTypeIdx = meta.node_fields.indexOf('type');
const nNameIdx = meta.node_fields.indexOf('name');
const nEdgeCountIdx = meta.node_fields.indexOf('edge_count');

const edgeFieldCount = meta.edge_fields.length;
const eTypeIdx = meta.edge_fields.indexOf('type');
const eNameIdx = meta.edge_fields.indexOf('name_or_index');
const eToIdx = meta.edge_fields.indexOf('to_node');

const nodeTypeNames = meta.node_types[0];
const edgeTypeNames = meta.edge_types[0];

const nodeType = (n: number) => nodeTypeNames[nodes[n * nodeFieldCount + nTypeIdx]] ?? '?';
const nodeName = (n: number) => strings[nodes[n * nodeFieldCount + nNameIdx]] ?? '?';
const label = (n: number) => `${nodeType(n)}:${nodeName(n)}`;

// ---- index ---------------------------------------------------------------------------------

// Where each node's edges start in the edge array.
const edgeStart = new Int32Array(nodeCount + 1);
for (let n = 0; n < nodeCount; n++) {
  edgeStart[n + 1] = edgeStart[n] + nodes[n * nodeFieldCount + nEdgeCountIdx];
}

const edgeCount = edgeStart[nodeCount];

/** Owner of each edge, i.e. the reverse of `to_node`, built by counting sort. */
const fromOf = new Int32Array(edgeCount);
for (let n = 0; n < nodeCount; n++) {
  for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) fromOf[e] = n;
}

const incomingCount = new Int32Array(nodeCount + 1);
for (let e = 0; e < edgeCount; e++) {
  const to = edges[e * edgeFieldCount + eToIdx] / nodeFieldCount;
  incomingCount[to + 1] += 1;
}
for (let n = 0; n < nodeCount; n++) incomingCount[n + 1] += incomingCount[n];

const incomingEdges = new Int32Array(edgeCount);
const cursor = incomingCount.slice(0, nodeCount);
for (let e = 0; e < edgeCount; e++) {
  const to = edges[e * edgeFieldCount + eToIdx] / nodeFieldCount;
  incomingEdges[cursor[to]++] = e;
}

const retainersOf = (n: number): number[] => {
  const out: number[] = [];
  for (let i = incomingCount[n]; i < incomingCount[n + 1]; i++) out.push(incomingEdges[i]);
  return out;
};

// ---- report --------------------------------------------------------------------------------

const wantType = flags.type === 'any' ? undefined : flags.type;
const matches = (n: number) => nodeName(n) === target && (wantType === undefined || nodeType(n) === wantType);

const targets: number[] = [];
let totalMatches = 0;

for (let n = 0; n < nodeCount; n++) {
  if (!matches(n)) continue;
  totalMatches += 1;
  if (targets.length < sampleLimit) targets.push(n);
}

console.log(`${totalMatches} ${wantType ?? 'any'} nodes named "${target}" (walking ${targets.length})\n`);

if (flags.path) {
  // Shortest path from a GC root, the way DevTools presents a retaining path. Immediate
  // retainers cannot answer "why is this alive" on their own: these objects sit in reference
  // cycles (a handle owns an AbortController whose abort reason's stack frames point back at
  // the handle), so walking up locally goes round the cycle instead of out of it.
  const parentEdge = new Int32Array(nodeCount).fill(-1);
  const seen = new Uint8Array(nodeCount);
  const queue = new Int32Array(nodeCount);
  let head = 0;
  let tail = 0;

  seen[0] = 1;
  queue[tail++] = 0;

  while (head < tail) {
    const n = queue[head++];

    for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
      const edgeType = edgeTypeNames[edges[e * edgeFieldCount + eTypeIdx]] ?? '?';
      if (edgeType === 'weak') continue; // weak edges do not keep anything alive

      const to = edges[e * edgeFieldCount + eToIdx] / nodeFieldCount;
      if (seen[to]) continue;

      seen[to] = 1;
      parentEdge[to] = e;
      queue[tail++] = to;
    }
  }

  const edgeLabel = (e: number): string => {
    const edgeType = edgeTypeNames[edges[e * edgeFieldCount + eTypeIdx]] ?? '?';
    const nameOrIndex = edges[e * edgeFieldCount + eNameIdx];
    if (edgeType === 'element' || edgeType === 'hidden') return '[]';
    const name = strings[nameOrIndex] ?? `#${nameOrIndex}`;
    // A numeric name is an index under another guise; keeping it would make every entry of a
    // collection its own distinct path.
    return /^\d+$/.test(name) ? '[]' : name;
  };

  const paths = new Map<string, number>();

  for (const n of targets) {
    const steps: string[] = [];
    let cur = n;

    while (cur !== 0 && parentEdge[cur] !== -1 && steps.length < 40) {
      const e = parentEdge[cur];
      const from = fromOf[e];
      steps.push(`${label(from)} .${edgeLabel(e)}`);
      cur = from;
    }

    const signature = steps.reverse().join('\n    -> ');
    paths.set(signature, (paths.get(signature) ?? 0) + 1);
  }

  const rows = [...paths].sort((a, b) => b[1] - a[1]).slice(0, top);

  for (const [signature, count] of rows) {
    console.log(`${count} instance(s) retained via:\n    -> ${signature}\n`);
  }

  Deno.exit(0);
}

let frontier = targets;

for (let level = 1; level <= depth && frontier.length > 0; level++) {
  const counts = new Map<string, number>();
  const next = new Set<number>();

  for (const n of frontier) {
    for (const e of retainersOf(n)) {
      const from = fromOf[e];
      const edgeType = edgeTypeNames[edges[e * edgeFieldCount + eTypeIdx]] ?? '?';
      const nameOrIndex = edges[e * edgeFieldCount + eNameIdx];
      // Element and hidden edges are indexed, not named. Keeping the index would scatter one
      // collection across as many rows as it has entries, which is the opposite of the point.
      const rawVia = strings[nameOrIndex] ?? `#${nameOrIndex}`;
      const via = edgeType === 'element' || edgeType === 'hidden' || /^\d+$/.test(rawVia) ? '[]' : rawVia;

      const key = `${label(from)} .${via}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (next.size < sampleLimit) next.add(from);
    }
  }

  console.log(`--- retainers, level ${level} ---`);
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, top);
  for (const [key, count] of rows) console.log(`${String(count).padStart(9)}  ${key}`);
  console.log();

  frontier = [...next];
}
