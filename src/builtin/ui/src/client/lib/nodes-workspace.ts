/**
 * The explorer's saved shape: one pane or two side by side, each with tabs,
 * each tab a location.
 *
 * Pure so it can be tested, and versioned so a reload after a change of shape
 * falls back to the default rather than crashing on a stale record — the same
 * contract `parseTerminalWorkspace` keeps. What is kept is what a person would
 * set up again by hand: where each tab is, how it is viewed, how it is sorted.
 * Expanded rows and the selection are not; they are the state of a visit.
 */

import { DEFAULT_COLUMN_WIDTHS, parseColumnWidths } from './node-columns.ts';

export type ViewMode = 'details' | 'list' | 'icons';
export type SortKey = 'name' | 'type' | 'size' | 'modified';
export type SortDir = 'asc' | 'desc';
export type NodeSort = { key: SortKey; dir: SortDir };

export type NodeTab = {
  id: string;
  path: string;
  view: ViewMode;
  sort: NodeSort;
};

export type PaneState = {
  /** Keys the pane's view, so closing the left pane keeps the right one's trees mounted as it moves over. */
  id: string;
  tabs: NodeTab[];
  activeTabId: string;
};

export type PaneIndex = 0 | 1;

export type NodesWorkspace = {
  version: 2;
  /** One pane, or two side by side; a second is opened on demand. */
  panes: PaneState[];
  focused: PaneIndex;
  /** The left pane's share of the width with two panes, 0.2–0.8. */
  split: number;
  /** The tool pane on the right: whether it is open, its width in pixels, and which tool it shows. */
  tools: ToolPaneState;
  /** Whether names starting with a dot are listed, in every tab. */
  showHidden: boolean;
  /** The details view's column widths in pixels, in every tab (`node-columns.ts`). */
  columns: number[];
};

/**
 * What the tool pane shows about the focused pane's current row: one of the shell's own tools,
 * or the id of a `nodes.tools` panel — a module's route, given the row's path.
 */
export type NodeTool = string;
export type ToolPaneState = { open: boolean; width: number; tool: NodeTool };

export const NODES_WORKSPACE_KEY = 'ein.nodes-workspace.v1';
export const MAX_PANES = 2;
export const VIEW_MODES: ViewMode[] = ['details', 'list', 'icons'];
export const SORT_KEYS: SortKey[] = ['name', 'type', 'size', 'modified'];
/** A stored tool: a shell tool's name or a panel's id (`archive.duplicates`); one no longer there shows the preview. */
const TOOL_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TABS = 20;
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
const MIN_TOOLS_WIDTH = 240;
const MAX_TOOLS_WIDTH = 720;

export const DEFAULT_SORT: NodeSort = { key: 'name', dir: 'asc' };
export const DEFAULT_TOOLS: ToolPaneState = { open: true, width: 340, tool: 'preview' };

const newId = (prefix: string): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const newTabId = (): string => newId('tab');

export function newTab(path = '/', view: ViewMode = 'details', sort: NodeSort = DEFAULT_SORT): NodeTab {
  return { id: newTabId(), path, view, sort };
}

export function newPane(tab: NodeTab = newTab()): PaneState {
  return { id: newId('pane'), tabs: [tab], activeTabId: tab.id };
}

export function defaultWorkspace(): NodesWorkspace {
  return {
    version: 2,
    panes: [newPane()],
    focused: 0,
    split: 0.5,
    tools: { ...DEFAULT_TOOLS },
    showHidden: false,
    columns: [...DEFAULT_COLUMN_WIDTHS],
  };
}

const clampSplit = (value: number): number => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
const clampToolsWidth = (value: number): number => Math.round(Math.min(MAX_TOOLS_WIDTH, Math.max(MIN_TOOLS_WIDTH, value)));

/** The tool pane; whatever is missing or malformed takes the default. */
function parseTools(raw: unknown): ToolPaneState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TOOLS };
  const tools = raw as Partial<ToolPaneState>;
  return {
    open: typeof tools.open === 'boolean' ? tools.open : DEFAULT_TOOLS.open,
    width: typeof tools.width === 'number' && Number.isFinite(tools.width) ? clampToolsWidth(tools.width) : DEFAULT_TOOLS.width,
    tool: typeof tools.tool === 'string' && TOOL_PATTERN.test(tools.tool) ? tools.tool : DEFAULT_TOOLS.tool,
  };
}

function parseTab(raw: unknown): NodeTab | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tab = raw as Partial<NodeTab>;
  if (typeof tab.id !== 'string' || !ID_PATTERN.test(tab.id)) return undefined;
  if (typeof tab.path !== 'string' || !tab.path.startsWith('/') || tab.path.length > 4096) return undefined;
  const view = VIEW_MODES.includes(tab.view as ViewMode) ? tab.view as ViewMode : 'details';
  const sort = tab.sort && SORT_KEYS.includes(tab.sort.key) && (tab.sort.dir === 'asc' || tab.sort.dir === 'desc') ? { key: tab.sort.key, dir: tab.sort.dir } : DEFAULT_SORT;
  return { id: tab.id, path: tab.path, view, sort };
}

function parsePane(raw: unknown): PaneState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const pane = raw as Partial<PaneState>;
  if (!Array.isArray(pane.tabs)) return undefined;
  const tabs = pane.tabs.slice(0, MAX_TABS).flatMap((tab) => parseTab(tab) ?? []);
  if (tabs.length === 0 || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) return undefined;
  const activeTabId = typeof pane.activeTabId === 'string' && tabs.some((tab) => tab.id === pane.activeTabId) ? pane.activeTabId : tabs[0].id;
  if (typeof pane.id !== 'string' || !ID_PATTERN.test(pane.id)) return undefined;
  return { id: pane.id, tabs, activeTabId };
}

/** A stored workspace, or `undefined` for anything that is not one. */
export function parseNodesWorkspace(raw: string | null): NodesWorkspace | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Omit<Partial<NodesWorkspace>, 'version'> & { version?: number };
    if (value.version !== 2 || !Array.isArray(value.panes) || value.panes.length < 1 || value.panes.length > MAX_PANES) return undefined;
    const panes = value.panes.map(parsePane);
    if (!panes.every((pane) => pane !== undefined)) return undefined;
    // Tab ids must be unique across both panes: a tab is addressed by id when
    // one is dragged or focused, and two panes must not answer to one id.
    // Pane ids key the panes' views, so they must be unique too.
    const ids = panes.flatMap((pane) => pane.tabs.map((tab) => tab.id));
    if (new Set(ids).size !== ids.length || new Set(panes.map((pane) => pane.id)).size !== panes.length) return undefined;
    return {
      version: 2,
      panes,
      focused: value.focused === 1 && panes.length > 1 ? 1 : 0,
      split: typeof value.split === 'number' && Number.isFinite(value.split) ? clampSplit(value.split) : 0.5,
      tools: parseTools(value.tools),
      showHidden: value.showHidden === true,
      columns: parseColumnWidths(value.columns),
    };
  } catch {
    return undefined;
  }
}

export const activeTabOf = (pane: PaneState): NodeTab => pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];

function updatePane(ws: NodesWorkspace, index: PaneIndex, update: (pane: PaneState) => PaneState): NodesWorkspace {
  if (!ws.panes[index]) return ws;
  const panes = [...ws.panes];
  panes[index] = update(panes[index]);
  return { ...ws, panes };
}

/** Open a second pane beside the first and give it the keyboard. With two open already, nothing happens. */
export function openPane(ws: NodesWorkspace, pane: PaneState): NodesWorkspace {
  if (ws.panes.length >= MAX_PANES) return ws;
  return { ...ws, panes: [...ws.panes, pane], focused: ws.panes.length as PaneIndex };
}

/** Close one of two panes; the other takes the whole width and the keyboard. The last pane cannot be closed. */
export function closePane(ws: NodesWorkspace, index: PaneIndex): NodesWorkspace {
  if (ws.panes.length <= 1 || !ws.panes[index]) return ws;
  return { ...ws, panes: ws.panes.filter((_, at) => at !== index), focused: 0 };
}

function updateTab(ws: NodesWorkspace, index: PaneIndex, tabId: string, update: (tab: NodeTab) => NodeTab): NodesWorkspace {
  return updatePane(ws, index, (pane) => ({ ...pane, tabs: pane.tabs.map((tab) => tab.id === tabId ? update(tab) : tab) }));
}

/** Open a new tab after the active one and make it active. Beyond the cap, nothing happens. */
export function addTab(ws: NodesWorkspace, index: PaneIndex, tab: NodeTab): NodesWorkspace {
  return updatePane(ws, index, (pane) => {
    if (pane.tabs.length >= MAX_TABS) return pane;
    const at = pane.tabs.findIndex((existing) => existing.id === pane.activeTabId);
    const tabs = [...pane.tabs];
    tabs.splice(at + 1, 0, tab);
    return { ...pane, tabs, activeTabId: tab.id };
  });
}

/** Close a tab; the last tab in a pane cannot be closed. Closing the active tab activates its neighbour. */
export function closeTab(ws: NodesWorkspace, index: PaneIndex, tabId: string): NodesWorkspace {
  return updatePane(ws, index, (pane) => {
    if (pane.tabs.length <= 1) return pane;
    const at = pane.tabs.findIndex((tab) => tab.id === tabId);
    if (at < 0) return pane;
    const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId = pane.activeTabId === tabId ? tabs[Math.min(at, tabs.length - 1)].id : pane.activeTabId;
    return { ...pane, tabs, activeTabId };
  });
}

export function setActiveTab(ws: NodesWorkspace, index: PaneIndex, tabId: string): NodesWorkspace {
  return updatePane(ws, index, (pane) => pane.tabs.some((tab) => tab.id === tabId) ? { ...pane, activeTabId: tabId } : pane);
}

export function setTabPath(ws: NodesWorkspace, index: PaneIndex, tabId: string, path: string): NodesWorkspace {
  return updateTab(ws, index, tabId, (tab) => ({ ...tab, path }));
}

export function setTabView(ws: NodesWorkspace, index: PaneIndex, tabId: string, view: ViewMode): NodesWorkspace {
  return updateTab(ws, index, tabId, (tab) => ({ ...tab, view }));
}

export function setTabSort(ws: NodesWorkspace, index: PaneIndex, tabId: string, sort: NodeSort): NodesWorkspace {
  return updateTab(ws, index, tabId, (tab) => ({ ...tab, sort }));
}

export function setSplit(ws: NodesWorkspace, split: number): NodesWorkspace {
  return { ...ws, split: clampSplit(split) };
}

export function setFocused(ws: NodesWorkspace, focused: PaneIndex): NodesWorkspace {
  return ws.focused === focused || !ws.panes[focused] ? ws : { ...ws, focused };
}

export function setToolsOpen(ws: NodesWorkspace, open: boolean): NodesWorkspace {
  return ws.tools.open === open ? ws : { ...ws, tools: { ...ws.tools, open } };
}

export function setToolsWidth(ws: NodesWorkspace, width: number): NodesWorkspace {
  return { ...ws, tools: { ...ws.tools, width: clampToolsWidth(width) } };
}

export function setColumns(ws: NodesWorkspace, columns: number[]): NodesWorkspace {
  return { ...ws, columns: parseColumnWidths(columns) };
}

export function setShowHidden(ws: NodesWorkspace, showHidden: boolean): NodesWorkspace {
  return ws.showHidden === showHidden ? ws : { ...ws, showHidden };
}

/** Show a tool; choosing one opens the pane, since the choice is made to see it. */
export function setTool(ws: NodesWorkspace, tool: NodeTool): NodesWorkspace {
  return ws.tools.tool === tool && ws.tools.open ? ws : { ...ws, tools: { ...ws.tools, tool, open: true } };
}
