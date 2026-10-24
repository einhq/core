/**
 * Base tile layer definitions. Data-driven so self-hosted tile sources can be
 * added later without touching MapView.
 */

// @ts-types="@types/leaflet"
import type { TileLayerOptions } from 'leaflet';

export type TileLayerDef = {
  name: string;
  tiles: { url: string; options: TileLayerOptions }[];
};

/** The first is the default: what a map shows when nothing names another. */
export const BASE_LAYERS: TileLayerDef[] = [
  {
    name: 'Map',
    tiles: [{
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { attribution: '© OpenStreetMap contributors', maxZoom: 19 },
    }],
  },
  {
    name: 'Dark map',
    tiles: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        options: {
          attribution: 'Tiles © Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community',
          maxNativeZoom: 16,
          maxZoom: 19,
        },
      },
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
        options: { maxNativeZoom: 16, maxZoom: 19 },
      },
    ],
  },
  {
    name: 'Satellite',
    tiles: [{
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { attribution: 'Tiles © Esri', maxZoom: 19 },
    }],
  },
];
