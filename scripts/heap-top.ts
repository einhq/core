/**
 * Summarise a .heapsnapshot by object class: count and total self size.
 *
 * Streaming on purpose. A snapshot of a 1.5 GB heap is a >2 GB JSON document, so JSON.parse
 * of the whole file needs more heap than the process being debugged had — the usual reason
 * a leak hunt stalls at "the snapshot is too big to open".
 *
 *   deno run -A scripts/heap-top.ts /files-tmp/heap-1.heapsnapshot
 *   deno run -A scripts/heap-top.ts --json a.heapsnapshot > a.json   # for diffing
 *   deno run -A scripts/heap-top.ts --diff a.json b.heapsnapshot     # what grew between them
 *
 * The diff is the part that finds leaks: one snapshot tells you what a heap is made of,
 * two an hour apart tell you what is still being added.
 *
 * Only the `nodes` and `strings` sections are read. `edges` is skipped, so this says what is
 * on the heap but not who retains it — for that, open the snapshot in Chrome DevTools.
 */

import { parseArgs } from '@std/cli/parse-args';

type Bucket = { count: number; size: number };
type Summary = Record<string, Bucket>;

const flags = parseArgs(Deno.args, {
  string: ['diff', 'top'],
  boolean: ['json'],
  default: { top: '40' },
});

const path = flags._[0] as string | undefined;

if (!path) {
  console.error('usage: heap-top.ts [--json] [--diff <baseline.json>] [--top N] <file.heapsnapshot>');
  Deno.exit(2);
}

/**
 * Aggregates keyed by `<type index>:<name index>`; `strings` resolves the names afterwards.
 *
 * Keyed by the pair, not the name alone: one name can belong to several node types (a `Date`
 * exists as an object, as code, and as a string), and folding those together mislabels every
 * one of them after the first.
 */
const byName = new Map<string, Bucket>();
const wantedNames = new Set<number>();
const names = new Map<number, string>();

/**
 * For a string node the "name" is its content, so keying those by name would put millions of
 * one-off entries in this map — the analyser would then need the heap it is trying to explain.
 * They collapse to one bucket per type under a negative key instead.
 */
const COLLAPSED = new Set(['string', 'concatenated string', 'sliced string', 'symbol', 'number', 'bigint']);
let collapsedTypes = new Set<number>();

let nodeFields: string[] = [];
let nodeTypes: string[] = [];
let fieldCount = 0;
let typeIdx = 0;
let nameIdx = 0;
let selfIdx = 0;

let phase: 'header' | 'nodes' | 'seek-strings' | 'strings' | 'done' = 'header';
let buffered = '';

// Digit accumulator for the nodes array. Deliberately kept across chunk boundaries so a
// number split by a read never needs re-scanning.
let value = 0;
let inNumber = false;
let field = 0;
let nodeType = 0;
let nodeName = 0;
let nodeSelf = 0;

// String scanner state, likewise carried across chunks.
let stringIndex = 0;
let inString = false;
let escaped = false;
let current = '';

const scanNodes = (text: string): number => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);

    if (c >= 48 && c <= 57) {
      value = value * 10 + (c - 48);
      inNumber = true;
      continue;
    }

    if (inNumber) {
      if (field === typeIdx) nodeType = value;
      else if (field === nameIdx) nodeName = value;
      else if (field === selfIdx) nodeSelf = value;

      value = 0;
      inNumber = false;
      field += 1;

      if (field === fieldCount) {
        const collapsed = collapsedTypes.has(nodeType);
        const key = collapsed ? `${nodeType}:*` : `${nodeType}:${nodeName}`;
        const bucket = byName.get(key);

        if (bucket) {
          bucket.count += 1;
          bucket.size += nodeSelf;
        } else {
          byName.set(key, { count: 1, size: nodeSelf });
          if (!collapsed) wantedNames.add(nodeName);
        }
        field = 0;
      }
    }

    if (c === 93) return i + 1; // ']' ends the array
  }

  return -1;
};

const scanStrings = (text: string): number => {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        if (wantedNames.has(stringIndex)) names.set(stringIndex, current);
        stringIndex += 1;
        current = '';
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      current = '';
    } else if (ch === ']') {
      return i + 1;
    }
  }

  return -1;
};

const handle = await Deno.open(path, { read: true });
const decoder = new TextDecoder();

for await (const buf of handle.readable) {
  buffered += decoder.decode(buf, { stream: true });

  if (phase === 'header') {
    const marker = buffered.indexOf('"nodes"');
    if (marker === -1) continue;

    const header = JSON.parse(buffered.slice(buffered.indexOf('{'), marker).replace(/,\s*$/, '') + '}');
    const meta = header.snapshot.meta;
    nodeFields = meta.node_fields;
    nodeTypes = meta.node_types[0];
    fieldCount = nodeFields.length;
    typeIdx = nodeFields.indexOf('type');
    nameIdx = nodeFields.indexOf('name');
    selfIdx = nodeFields.indexOf('self_size');
    collapsedTypes = new Set(nodeTypes.flatMap((name, i) => COLLAPSED.has(name) ? [i] : []));

    buffered = buffered.slice(buffered.indexOf('[', marker) + 1);
    phase = 'nodes';
  }

  if (phase === 'nodes') {
    const end = scanNodes(buffered);
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
      // Nothing between the arrays is needed; hold back enough to match a split key.
      buffered = buffered.slice(-16);
      continue;
    }
    buffered = buffered.slice(buffered.indexOf('[', marker) + 1);
    phase = 'strings';
  }

  if (phase === 'strings') {
    const end = scanStrings(buffered);
    buffered = '';
    if (end !== -1) {
      phase = 'done';
      break;
    }
  }
}

if (phase === 'header') {
  console.error('could not read snapshot header — is this a .heapsnapshot?');
  Deno.exit(1);
}

const summary: Summary = {};

for (const [key, bucket] of byName) {
  const [typeIndex, nameKey] = key.split(':');
  const type = nodeTypes[Number(typeIndex)] ?? '?';
  const label = nameKey === '*' ? `${type}:(all)` : `${type}:${names.get(Number(nameKey)) ?? `#${nameKey}`}`;
  const existing = summary[label];

  if (existing) {
    existing.count += bucket.count;
    existing.size += bucket.size;
  } else {
    summary[label] = { ...bucket };
  }
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1).padStart(8);

if (flags.diff) {
  const baseline: Summary = JSON.parse(await Deno.readTextFile(flags.diff));
  const rows = Object.entries(summary)
    .map(([label, b]) => {
      const before = baseline[label] ?? { count: 0, size: 0 };
      return { label, dCount: b.count - before.count, dSize: b.size - before.size };
    })
    .filter((r) => r.dSize !== 0)
    .sort((a, b) => b.dSize - a.dSize)
    .slice(0, Number(flags.top));

  console.log('   Δ MB     Δ count  class');
  for (const r of rows) {
    console.log(`${mb(r.dSize)}  ${String(r.dCount).padStart(10)}  ${r.label}`);
  }
} else if (flags.json) {
  console.log(JSON.stringify(summary));
} else {
  const rows = Object.entries(summary).sort((a, b) => b[1].size - a[1].size).slice(0, Number(flags.top));
  const total = Object.values(summary).reduce((sum, b) => sum + b.size, 0);

  console.log(`total self size: ${(total / 1024 / 1024).toFixed(1)} MB across ${Object.keys(summary).length} classes\n`);
  console.log('      MB       count  class');
  for (const [label, b] of rows) {
    console.log(`${mb(b.size)}  ${String(b.count).padStart(10)}  ${label}`);
  }
}
