/**
 * A map's style and layer picker, a button in its top-right corner: a style is shown as a picture of
 * where the map is looking rather than by name, and each layer as a switch.
 */

import { ActionIcon, Group, Popover, SimpleGrid, Stack, Switch, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useState } from 'react';
import type { MapLayerEntry, MapStyleEntry, MapTiles } from '../../signals/nav.ts';
import { TablerIcon } from '../Icon/TablerIcon.tsx';
import { useMapViewport } from './context.ts';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from './defaults.ts';

/** The slippy-map tile holding a point, at a zoom. */
function tileAt(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** A tile URL filled in; `{s}` takes Leaflet's first subdomain. */
function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{s}', 'a').replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{r}', '');
}

/** Whether a point lies in a tile set's `bounds`, `[[south, west], [north, east]]`; anywhere when it has none. */
function inBounds(bounds: unknown, lat: number, lng: number): boolean {
  if (!Array.isArray(bounds) || bounds.length !== 2) return true;
  const [[south, west], [north, east]] = bounds as [number, number][];
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

/**
 * The tile a tile set draws at a point and zoom, as Leaflet would: none outside its `minZoom`,
 * `maxZoom` and `bounds`, and past its `maxNativeZoom` the coarser tile it stretches.
 */
function previewTile(tiles: MapTiles, lat: number, lng: number, z: number): string | undefined {
  const { minZoom, maxZoom, maxNativeZoom, bounds } = tiles.options ?? {};
  if ((typeof minZoom === 'number' && z < minZoom) || (typeof maxZoom === 'number' && z > maxZoom)) return undefined;
  if (!inBounds(bounds, lat, lng)) return undefined;
  const at = typeof maxNativeZoom === 'number' ? Math.min(z, maxNativeZoom) : z;
  const { x, y } = tileAt(lat, lng, at);
  return tileUrl(tiles.url, at, x, y);
}

type MapPickerProps = {
  /** The styles to pick from; none leaves the styles out. */
  styles: MapStyleEntry[];
  style: string | undefined;
  onStyleChange: (id: string) => void;
  /** The layers to switch; none leaves the layers out. */
  layers: MapLayerEntry[];
  on: readonly string[];
  onLayersChange: (ids: string[]) => void;
  /** A line under a layer's switch, by its id: why it draws nothing now. */
  notes: Record<string, string>;
};

/**
 * The picker: the styles as pictures of one tile of where the map looks, a step further out so it
 * holds more than a street, each tile set stacked as the map stacks them and the one showing ringed;
 * under them the layers, each a switch with its icon and what it shows. A pick of a style closes it
 * when it offers nothing else; a switch leaves it open for the next.
 */
export function MapPicker({ styles, style, onStyleChange, layers, on, onLayersChange, notes }: MapPickerProps) {
  const [open, setOpen] = useState(false);
  const viewport = useMapViewport();
  const bounds = viewport?.bounds;
  const at = bounds ? { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 } : DEFAULT_CENTER;
  const z = Math.min(Math.max(Math.round((viewport?.zoom ?? DEFAULT_ZOOM) - 1), 2), 16);
  const offersStyles = styles.length > 1;
  const name = offersStyles && layers.length > 0 ? 'Map style and layers' : offersStyles ? 'Map style' : 'Layers';
  const showing = styles.find((each) => each.id === style) ?? styles[0];
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(on);
    if (checked) next.add(id);
    else next.delete(id);
    onLayersChange(layers.map((layer) => layer.id).filter((each) => next.has(each)));
  };

  return (
    <Popover opened={open} onChange={setOpen} position='left-start' shadow='md' withinPortal>
      <Popover.Target>
        <Tooltip label={name} position='left' disabled={open}>
          <ActionIcon className='mrx-map-button' aria-label={offersStyles && showing ? `${name}: ${showing.label}` : name} onClick={() => setOpen((was) => !was)}>
            <TablerIcon name='stack-2' size={22} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p='sm' maw='min(320px, calc(100vw - 80px))'>
        <Stack gap='md'>
          {offersStyles && (
            <SimpleGrid cols={Math.min(styles.length, 3)} spacing='xs' verticalSpacing='xs'>
              {styles.map((each) => {
                const chosen = each.id === showing?.id;
                return (
                  <UnstyledButton
                    key={each.id}
                    aria-label={each.label}
                    aria-pressed={chosen}
                    onClick={() => {
                      onStyleChange(each.id);
                      if (layers.length === 0) setOpen(false);
                    }}
                  >
                    <Stack gap={4} align='center'>
                      <div className='mrx-map-style' data-selected={chosen || undefined}>
                        {each.tiles.map((tiles) => {
                          const src = previewTile(tiles, at.lat, at.lng, z);
                          // A tile set with nothing at this place, such as a chart of another coast, leaves the picture to the sets below it.
                          return src && <img key={tiles.url} src={src} alt='' loading='lazy' onError={(event) => (event.currentTarget.style.visibility = 'hidden')} />;
                        })}
                      </div>
                      <Text size='xs' c={chosen ? undefined : 'dimmed'} fw={chosen ? 600 : undefined} ta='center' lineClamp={1}>{each.label}</Text>
                    </Stack>
                  </UnstyledButton>
                );
              })}
            </SimpleGrid>
          )}
          {layers.length > 0 && (
            <Stack gap='xs'>
              {offersStyles && <Text size='xs' fw={700} c='dimmed' tt='uppercase'>Layers</Text>}
              {layers.map((layer) => {
                const note = notes[layer.id] ?? layer.description;
                return (
                  <Switch
                    key={layer.id}
                    checked={on.includes(layer.id)}
                    onChange={(event) => toggle(layer.id, event.currentTarget.checked)}
                    labelPosition='left'
                    styles={{ body: { justifyContent: 'space-between' }, labelWrapper: { flex: 1 } }}
                    label={
                      <Group gap='xs' wrap='nowrap'>
                        <TablerIcon name={layer.icon ?? 'map-2'} size={18} />
                        <Text size='sm'>{layer.label}</Text>
                      </Group>
                    }
                    description={note}
                  />
                );
              })}
            </Stack>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
