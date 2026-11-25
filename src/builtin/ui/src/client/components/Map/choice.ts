/**
 * The style and layers a reader has chosen for maps, kept as their own settings: `CFG_USER_MAP_STYLE`
 * for every map that names no style, `CFG_USER_MAP_LAYERS` for the Map page.
 */

import { userConfig } from '../../signals/config.ts';
import { mapLayers, mapStyles } from '../../signals/nav.ts';
import { execCommand } from '../../signals/shell-client.ts';
import { isAuthenticated } from '../../signals/user.ts';
import { shq } from '../../lib/shquote.ts';

/** The style a map shows when it names none: the reader's own while it is still offered, else the first. */
export const defaultMapStyle = (): string | undefined => {
  const styles = mapStyles();
  const own = userConfig.value.CFG_USER_MAP_STYLE;
  return (styles.find((style) => style.id === own) ?? styles[0])?.id;
};

/** The layers a map shows `ids` as: those still offered, in the order the layers come. */
export const offeredMapLayers = (ids: readonly string[]): string[] => {
  const wanted = new Set(ids);
  return mapLayers().filter((layer) => wanted.has(layer.id)).map((layer) => layer.id);
};

/** The layers the reader last chose, those still offered; until they have chosen, the layers that start on. */
export const chosenMapLayers = (): string[] => {
  const own = (userConfig.value.CFG_USER_MAP_LAYERS ?? '').trim();
  if (own === '') return mapLayers().filter((layer) => layer.on === true).map((layer) => layer.id);
  if (own === 'none') return [];
  return offeredMapLayers(own.split(',').map((id) => id.trim()));
};

/** Keep what the reader chose as their own settings, for the next map that opens; the guest's is not kept. */
export const keepMapChoice = (choice: { style?: string; layers?: string[] }): void => {
  const values: Record<string, string> = {};
  if (choice.style !== undefined) values.CFG_USER_MAP_STYLE = choice.style;
  if (choice.layers !== undefined) values.CFG_USER_MAP_LAYERS = choice.layers.length > 0 ? choice.layers.join(',') : 'none';
  const changed = Object.entries(values).filter(([key, value]) => userConfig.value[key] !== value);
  if (changed.length === 0 || !isAuthenticated.value) return;
  userConfig.value = { ...userConfig.value, ...values };
  execCommand(`config set ${changed.map(([key, value]) => shq(`${key}=${value}`)).join(' ')}`).catch(() => {});
};
