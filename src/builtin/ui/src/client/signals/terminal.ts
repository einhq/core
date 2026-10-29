import { signal } from '@preact/signals-react';

export interface TerminalTab {
  id: string;
  title: string;
  connected: boolean;
  pwd?: string;
  /** Queued once for this tab's interactive shell as it connects. */
  initialCommand?: string;
}

export type StoredTerminalWorkspace = {
  version: 1;
  open: boolean;
  activeTabId: string;
  tabs: Array<Pick<TerminalTab, 'id' | 'title' | 'pwd'>>;
};

export const TERMINAL_WORKSPACE_KEY = 'ein.terminal-workspace.v1';
const TERMINAL_WORKSPACE_ID_KEY = 'ein.terminal-workspace-id.v1';
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STORED_TABS = 50;

const newTerminalId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `tab-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
const defaultTab = (): TerminalTab => ({ id: newTerminalId(), title: 'Session 1', connected: false });

export function parseTerminalWorkspace(raw: string | null): StoredTerminalWorkspace | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredTerminalWorkspace>;
    if (value.version !== 1 || typeof value.open !== 'boolean' || !Array.isArray(value.tabs)) return undefined;

    const tabs = value.tabs.slice(0, MAX_STORED_TABS).flatMap((tab) => {
      if (
        !tab || typeof tab.id !== 'string' || !TERMINAL_ID_PATTERN.test(tab.id) ||
        typeof tab.title !== 'string' || tab.title.length === 0 || tab.title.length > 200 ||
        (tab.pwd !== undefined && typeof tab.pwd !== 'string')
      ) return [];
      return [{ id: tab.id, title: tab.title, ...(tab.pwd === undefined ? {} : { pwd: tab.pwd }) }];
    });
    if (tabs.length === 0 || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) return undefined;

    const activeTabId = typeof value.activeTabId === 'string' && tabs.some((tab) => tab.id === value.activeTabId) ? value.activeTabId : tabs[0].id;
    return { version: 1, open: value.open, activeTabId, tabs };
  } catch {
    return undefined;
  }
}

function loadTerminalWorkspace(): StoredTerminalWorkspace | undefined {
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    return parseTerminalWorkspace(sessionStorage.getItem(TERMINAL_WORKSPACE_KEY));
  } catch {
    return undefined;
  }
}

const storedWorkspace = loadTerminalWorkspace();
const initialTabs: TerminalTab[] = storedWorkspace?.tabs.map((tab) => ({ ...tab, connected: false })) ?? [defaultTab()];

function loadTerminalWorkspaceId(): string {
  let id: string | null = null;
  try {
    id = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(TERMINAL_WORKSPACE_ID_KEY);
  } catch {
    // Storage may be unavailable; the in-memory id still isolates this page.
  }
  if (!id || !TERMINAL_ID_PATTERN.test(id)) id = initialTabs[0].id;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(TERMINAL_WORKSPACE_ID_KEY, id);
  } catch {
    // Storage may be disabled or full; terminals still work for this page.
  }
  return id;
}

/** Terminal open/closed state, restored for this browser tab's session. */
export const terminalOpen = signal(storedWorkspace?.open ?? false);

/**
 * Terminal height percentage (10-100). Height is a durable preference, unlike
 * the terminal workspace itself, so it is kept in localStorage.
 */
const TERMINAL_HEIGHT_KEY = 'terminal-height';
const DEFAULT_HEIGHT = 50;
const MIN_HEIGHT = 10;
const MAX_HEIGHT = 100;
const HEIGHT_STEP = 10;

const getStoredHeight = (): number => {
  if (typeof localStorage === 'undefined') return DEFAULT_HEIGHT;
  const stored = localStorage.getItem(TERMINAL_HEIGHT_KEY);
  if (stored) {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed >= MIN_HEIGHT && parsed <= MAX_HEIGHT) return parsed;
  }
  return DEFAULT_HEIGHT;
};

export const terminalHeight = signal(getStoredHeight());
export const terminalTabs = signal<TerminalTab[]>(initialTabs);
export const activeTerminalTab = signal(storedWorkspace?.activeTabId ?? initialTabs[0].id);
export const terminalWorkspaceId = signal(loadTerminalWorkspaceId());

const terminators = new Map<string, () => void>();

function persistTerminalWorkspace(): void {
  if (typeof sessionStorage === 'undefined') return;
  const workspace: StoredTerminalWorkspace = {
    version: 1,
    open: terminalOpen.value,
    activeTabId: activeTerminalTab.value,
    // `connected` is transport state and `initialCommand` is deliberately
    // one-shot; neither may be replayed after a browser reload.
    tabs: terminalTabs.value.map(({ id, title, pwd }) => ({ id, title, ...(pwd === undefined ? {} : { pwd }) })),
  };
  try {
    sessionStorage.setItem(TERMINAL_WORKSPACE_KEY, JSON.stringify(workspace));
  } catch {
    // Storage may be disabled or full; terminals still work for this page.
  }
}

/**
 * A new top-level browser tab can inherit a copy of its opener's sessionStorage.
 * Replace that copied workspace without terminating the original tab's shells.
 */
export function resetCopiedTerminalWorkspace(expectedWorkspaceId: string): void {
  if (terminalWorkspaceId.value !== expectedWorkspaceId) return;
  resetTerminalWorkspace();
}

/**
 * Start over with one fresh, closed terminal under new ids — on logout, so the
 * next login on this browser tab does not restore the previous user's tabs.
 */
export function resetTerminalWorkspace(): void {
  const replacement = defaultTab();
  terminalTabs.value = [replacement];
  activeTerminalTab.value = replacement.id;
  terminalWorkspaceId.value = newTerminalId();
  terminalOpen.value = false;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(TERMINAL_WORKSPACE_ID_KEY, terminalWorkspaceId.value);
  } catch {
    // Storage may be disabled or full; the in-memory id still isolates this page.
  }
  persistTerminalWorkspace();
}

export function registerTerminalTerminator(tabId: string, terminate: () => void): () => void {
  terminators.set(tabId, terminate);
  return () => {
    if (terminators.get(tabId) === terminate) terminators.delete(tabId);
  };
}

export const terminalMaximizedToggle = () => {
  const newHeight = terminalHeight.value === MAX_HEIGHT ? DEFAULT_HEIGHT : MAX_HEIGHT;
  terminalHeight.value = newHeight;
  if (typeof localStorage !== 'undefined') localStorage.setItem(TERMINAL_HEIGHT_KEY, String(newHeight));
};

export const increaseTerminalHeight = () => {
  if (terminalHeight.value >= MAX_HEIGHT) return;
  const newHeight = Math.min(terminalHeight.value + HEIGHT_STEP, MAX_HEIGHT);
  terminalHeight.value = newHeight;
  if (typeof localStorage !== 'undefined') localStorage.setItem(TERMINAL_HEIGHT_KEY, String(newHeight));
};

export const decreaseTerminalHeight = () => {
  if (terminalHeight.value <= MIN_HEIGHT) return;
  const newHeight = Math.max(terminalHeight.value - HEIGHT_STEP, MIN_HEIGHT);
  terminalHeight.value = newHeight;
  if (typeof localStorage !== 'undefined') localStorage.setItem(TERMINAL_HEIGHT_KEY, String(newHeight));
};

export const setTabConnected = (tabId: string, connected: boolean) => {
  terminalTabs.value = terminalTabs.value.map((tab) => tab.id === tabId ? { ...tab, connected } : tab);
};

export const setTabPwd = (tabId: string, pwd: string) => {
  terminalTabs.value = terminalTabs.value.map((tab) => tab.id === tabId ? { ...tab, pwd } : tab);
  persistTerminalWorkspace();
};

export const terminalOpenToggle = () => {
  terminalOpen.value = !terminalOpen.value;
  persistTerminalWorkspace();
};

export const addTerminalTab = (initialCommand?: string) => {
  const newId = newTerminalId();
  const tabNumber = terminalTabs.value.length + 1;
  terminalTabs.value = [...terminalTabs.value, { id: newId, title: `Session ${tabNumber}`, connected: false, initialCommand }];
  activeTerminalTab.value = newId;
  persistTerminalWorkspace();
  return newId;
};

export const openTerminalTab = (initialCommand?: string) => {
  const id = addTerminalTab(initialCommand);
  terminalOpen.value = true;
  persistTerminalWorkspace();
  return id;
};

export const closeTerminalTab = (tabId: string) => {
  const tabs = terminalTabs.value;
  if (tabs.length <= 1) return;

  terminators.get(tabId)?.();
  removeTerminalTab(tabId);
};

/** A shell that exited is removed, while the required sole tab becomes a fresh shell. */
export const terminalTabExited = (tabId: string) => {
  const tabs = terminalTabs.value;
  if (tabs.length > 1) {
    removeTerminalTab(tabId);
    return;
  }
  if (tabs[0]?.id !== tabId) return;

  const replacement = defaultTab();
  terminalTabs.value = [replacement];
  activeTerminalTab.value = replacement.id;
  persistTerminalWorkspace();
};

function removeTerminalTab(tabId: string): void {
  const tabs = terminalTabs.value;
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;

  const remaining = tabs.filter((tab) => tab.id !== tabId);
  terminalTabs.value = remaining;
  if (activeTerminalTab.value === tabId) {
    activeTerminalTab.value = remaining[Math.min(index, remaining.length - 1)].id;
  }
  persistTerminalWorkspace();
}

export const switchTerminalTab = (tabId: string) => {
  if (!terminalTabs.value.some((tab) => tab.id === tabId)) return;
  activeTerminalTab.value = tabId;
  persistTerminalWorkspace();
};

export const nextTerminalTab = () => {
  const tabs = terminalTabs.value;
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTerminalTab.value);
  activeTerminalTab.value = tabs[(currentIndex + 1) % tabs.length].id;
  persistTerminalWorkspace();
};

export const prevTerminalTab = () => {
  const tabs = terminalTabs.value;
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTerminalTab.value);
  activeTerminalTab.value = tabs[(currentIndex - 1 + tabs.length) % tabs.length].id;
  persistTerminalWorkspace();
};
