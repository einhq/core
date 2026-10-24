import { assertEquals, assertNotEquals } from '@std/assert';
import {
  activeTabOf,
  addTab,
  closePane,
  closeTab,
  DEFAULT_TOOLS,
  defaultWorkspace,
  newPane,
  newTab,
  type NodesWorkspace,
  openPane,
  parseNodesWorkspace,
  setActiveTab,
  setColumns,
  setFocused,
  setShowHidden,
  setSplit,
  setTabPath,
  setTool,
  setToolsOpen,
  setToolsWidth,
} from '../nodes-workspace.ts';

/** The default workspace with a second pane open, as the menubar's Split leaves it. */
const twoPanes = (): NodesWorkspace => openPane(defaultWorkspace(), newPane());

Deno.test('nodes workspace: round-trips through JSON', () => {
  const ws = defaultWorkspace();
  assertEquals(ws.panes.length, 1);
  assertEquals(parseNodesWorkspace(JSON.stringify(ws)), ws);
  const split = twoPanes();
  assertEquals(parseNodesWorkspace(JSON.stringify(split)), split);
});

Deno.test('nodes workspace: rejects what is not a workspace', () => {
  assertEquals(parseNodesWorkspace(null), undefined);
  assertEquals(parseNodesWorkspace('{'), undefined);
  assertEquals(parseNodesWorkspace(JSON.stringify({ version: 3 })), undefined);
  const ws = twoPanes();
  const relative = { ...ws, panes: [{ ...ws.panes[0], tabs: [{ ...ws.panes[0].tabs[0], path: 'a' }] }, ws.panes[1]] };
  assertEquals(parseNodesWorkspace(JSON.stringify(relative)), undefined);
  // The same ids in both panes.
  const dup = { ...ws, panes: [ws.panes[0], ws.panes[0]] };
  assertEquals(parseNodesWorkspace(JSON.stringify(dup)), undefined);
  assertEquals(parseNodesWorkspace(JSON.stringify({ ...ws, panes: [] })), undefined);
  assertEquals(parseNodesWorkspace(JSON.stringify({ ...ws, panes: [...ws.panes, newPane()] })), undefined);
});

Deno.test('nodes workspace: a second pane opens with the keyboard, and closing either leaves the other', () => {
  const ws = defaultWorkspace();
  const second = newPane(newTab('/b'));
  const split = openPane(ws, second);
  assertEquals(split.panes, [ws.panes[0], second]);
  assertEquals(split.focused, 1);
  // Two is the most.
  assertEquals(openPane(split, newPane()), split);

  const leftGone = closePane(split, 0);
  assertEquals(leftGone.panes, [second]);
  assertEquals(leftGone.focused, 0);
  assertEquals(closePane(split, 1).panes, [ws.panes[0]]);
  // The last pane stays, and a pane that is not there cannot take the keyboard.
  assertEquals(closePane(ws, 0), ws);
  assertEquals(setFocused(ws, 1), ws);
});

Deno.test('nodes workspace: repairs a stale active id, an unknown view and a wild split', () => {
  const ws = defaultWorkspace();
  const raw = {
    ...ws,
    split: 3,
    panes: [{ ...ws.panes[0], tabs: [{ ...ws.panes[0].tabs[0], view: 'huge', sort: { key: 'nope', dir: 'asc' } }], activeTabId: 'gone' }],
  };
  const parsed = parseNodesWorkspace(JSON.stringify(raw))!;
  assertEquals(parsed.split, 0.8);
  assertEquals(parsed.panes[0].activeTabId, ws.panes[0].tabs[0].id);
  assertEquals(parsed.panes[0].tabs[0].view, 'details');
  assertEquals(parsed.panes[0].tabs[0].sort, { key: 'name', dir: 'asc' });
});

Deno.test('nodes workspace: tabs open after the active one and the last tab stays', () => {
  let ws: NodesWorkspace = twoPanes();
  const right = ws.panes[1];
  const first = ws.panes[0].tabs[0];
  const second = newTab('/a');
  const third = newTab('/b');
  ws = addTab(ws, 0, second);
  ws = setActiveTab(ws, 0, first.id);
  ws = addTab(ws, 0, third);
  assertEquals(ws.panes[0].tabs.map((tab) => tab.path), ['/', '/b', '/a']);
  assertEquals(activeTabOf(ws.panes[0]).id, third.id);

  ws = closeTab(ws, 0, third.id);
  assertEquals(activeTabOf(ws.panes[0]).id, second.id);
  ws = closeTab(ws, 0, second.id);
  ws = closeTab(ws, 0, first.id);
  assertEquals(ws.panes[0].tabs.length, 1);
  // The other pane was never touched.
  assertEquals(ws.panes[1], right);
});

Deno.test('nodes workspace: updates are immutable and scoped to one pane', () => {
  const ws = twoPanes();
  const moved = setTabPath(ws, 1, ws.panes[1].tabs[0].id, '/x');
  assertNotEquals(moved, ws);
  assertEquals(moved.panes[0], ws.panes[0]);
  assertEquals(moved.panes[1].tabs[0].path, '/x');
  assertEquals(ws.panes[1].tabs[0].path, '/');
  assertEquals(setSplit(ws, 0.05).split, 0.2);
});

Deno.test('nodes workspace: a missing or malformed tool pane takes the default', () => {
  const { tools: _, ...old } = defaultWorkspace();
  assertEquals(parseNodesWorkspace(JSON.stringify(old))?.tools, DEFAULT_TOOLS);
  const wild = { ...defaultWorkspace(), tools: { open: 'yes', width: 5000, tool: 'Hammer Time!' } };
  assertEquals(parseNodesWorkspace(JSON.stringify(wild))?.tools, { open: true, width: 720, tool: 'preview' });
  // A module's tool is kept by its panel id; one no longer installed is shown as the preview.
  const panel = { ...defaultWorkspace(), tools: { open: true, width: 340, tool: 'archive.duplicates' } };
  assertEquals(parseNodesWorkspace(JSON.stringify(panel))?.tools.tool, 'archive.duplicates');
});

Deno.test('nodes workspace: the tool pane opens, closes and keeps its width in bounds', () => {
  const ws = defaultWorkspace();
  const closed = setToolsOpen(ws, false);
  assertEquals(closed.tools.open, false);
  assertEquals(setToolsOpen(closed, false), closed);
  assertEquals(setToolsWidth(ws, 10).tools.width, 240);
  assertEquals(setToolsWidth(ws, 400.4).tools.width, 400);
  assertEquals(ws.tools, DEFAULT_TOOLS);
});

Deno.test('nodes workspace: column widths are kept, bounded, and a broken set falls back', () => {
  const ws = defaultWorkspace();
  const wide = setColumns(ws, [400, 10, 88, 104, 96, 96, 5000]);
  assertEquals(wide.columns, [400, 48, 88, 104, 96, 96, 960]);
  assertEquals(parseNodesWorkspace(JSON.stringify(wide))?.columns, wide.columns);
  assertEquals(parseNodesWorkspace(JSON.stringify({ ...ws, columns: [1, 2] }))?.columns, ws.columns);
});

Deno.test('nodes workspace: hidden names are off by default, and the choice is kept', () => {
  const ws = defaultWorkspace();
  assertEquals(ws.showHidden, false);
  const shown = setShowHidden(ws, true);
  assertEquals(setShowHidden(shown, true), shown);
  assertEquals(parseNodesWorkspace(JSON.stringify(shown))?.showHidden, true);
  assertEquals(parseNodesWorkspace(JSON.stringify({ ...ws, showHidden: 'yes' }))?.showHidden, false);
});

Deno.test('nodes workspace: choosing a tool shows it, opening a closed pane', () => {
  const ws = setToolsOpen(defaultWorkspace(), false);
  const sharing = setTool(ws, 'sharing');
  assertEquals(sharing.tools, { ...ws.tools, open: true, tool: 'sharing' });
  assertEquals(setTool(sharing, 'sharing'), sharing);
  assertEquals(parseNodesWorkspace(JSON.stringify(sharing))?.tools.tool, 'sharing');
});
