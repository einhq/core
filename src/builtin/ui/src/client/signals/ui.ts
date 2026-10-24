import { signal } from '@preact/signals-react';
import { PHONE_COLUMNS_MAX, PHONE_COLUMNS_MIN } from '../lib/pinch.ts';

const SIDEBAR_RAIL_KEY = 'ein.sidebar.rail';
const MOBILE_SIDEBAR_RAIL_KEY = 'ein.sidebar.mobileRail';
const MOBILE_RAIL_HIDDEN_KEY = 'ein.sidebar.mobileRailHidden';

/** A remembered on/off, or `fallback` where storage is empty or unavailable. */
const readFlag = (key: string, fallback: boolean): boolean => {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    return stored === null || stored === undefined ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
};

const writeFlag = (key: string, value: boolean) => {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    // Private mode or blocked storage: the choice lasts for this page load.
  }
};

/**
 * The sidebar drawn as an icon rail rather than with labels, beside the page
 * from the `sm` breakpoint up.
 */
export const sidebarCollapsed = signal(readFlag(SIDEBAR_RAIL_KEY, false));

/**
 * The same choice below `sm`, where the header's mark shows and hides the rail,
 * or opens the labelled list over the page. Kept apart because a phone and a desktop want different answers: a
 * labelled list covers the whole of a phone's page, so there it starts as the
 * rail.
 */
export const mobileSidebarRail = signal(readFlag(MOBILE_SIDEBAR_RAIL_KEY, true));

/**
 * A phone's rail put away, giving the page the whole width — the default, since on a phone the
 * pictures want every pixel of it. The header's mark brings the rail out.
 */
export const mobileRailHidden = signal(readFlag(MOBILE_RAIL_HIDDEN_KEY, true));

/** Show or hide a phone's rail. */
export const toggleMobileRailHidden = () => {
  mobileRailHidden.value = !mobileRailHidden.value;
  writeFlag(MOBILE_RAIL_HIDDEN_KEY, mobileRailHidden.value);
};

/** Switch between the labelled sidebar and the icon rail for the current screen size. */
export const toggleSidebar = (mobile: boolean) => {
  if (mobile) {
    mobileSidebarRail.value = !mobileSidebarRail.value;
    writeFlag(MOBILE_SIDEBAR_RAIL_KEY, mobileSidebarRail.value);
    // Collapsing the labels to the rail asks for the rail, so it is shown.
    if (mobileSidebarRail.value && mobileRailHidden.value) toggleMobileRailHidden();
  } else {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    writeFlag(SIDEBAR_RAIL_KEY, sidebarCollapsed.value);
  }
};

const PHONE_COLUMNS_KEY = 'ein.media.phoneColumns';

/** Pictures per row in a phone's media grid: two at first, more or fewer with a pinch. */
export const phoneGridColumns = signal((() => {
  try {
    const stored = Number(globalThis.localStorage?.getItem(PHONE_COLUMNS_KEY));
    return Number.isInteger(stored) && stored >= PHONE_COLUMNS_MIN && stored <= PHONE_COLUMNS_MAX ? stored : PHONE_COLUMNS_MIN;
  } catch {
    return PHONE_COLUMNS_MIN;
  }
})());

/** Set and remember a phone's pictures per row. */
export const setPhoneGridColumns = (columns: number) => {
  phoneGridColumns.value = columns;
  try {
    globalThis.localStorage?.setItem(PHONE_COLUMNS_KEY, String(columns));
  } catch {
    // Private mode or blocked storage: the choice lasts for this page load.
  }
};
