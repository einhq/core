/**
 * Inline-SVG divIcons — avoids bundling leaflet's default marker PNGs.
 */

// @ts-types="@types/leaflet"
import L from 'leaflet';

export const MARKER_COLOR = '#0d9488';
/** Highlighted marker — matches the amber the locations list uses for suggestions. */
export const ACTIVE_MARKER_COLOR = '#f59e0b';

/**
 * `color` may be a CSS variable — `kindFill('location')` is one — so it is set as a
 * style rather than the `fill` attribute, which does not resolve `var()`.
 */
export function pinIcon(color = MARKER_COLOR): L.DivIcon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z" style="fill:${color}"/>
    <circle cx="15" cy="15" r="6" fill="#fff"/>
  </svg>`;
  return L.divIcon({
    className: '',
    html: svg,
    iconSize: [30, 42],
    iconAnchor: [15, 42],
    popupAnchor: [0, -40],
  });
}

/**
 * A pin carrying a number, for a short ordered set the user picks one from.
 *
 * Geocoder suggestions are the case: a list of display names is hard to choose
 * between until you see where each one actually is, so the number is what ties
 * a row in the list to a pin on the map. `active` grows and recolours the pin so
 * hovering either half highlights the other.
 */
export function numberedPinIcon(label: number | string, active = false): L.DivIcon {
  const color = active ? ACTIVE_MARKER_COLOR : MARKER_COLOR;
  const [w, h] = active ? [38, 53] : [30, 42];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 30 42">
    <path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="15" cy="15" r="8.5" fill="#fff"/>
    <text x="15" y="15" text-anchor="middle" dominant-baseline="central"
      font-family="sans-serif" font-size="12" font-weight="700" fill="${color}">${label}</text>
  </svg>`;
  return L.divIcon({
    className: '',
    html: svg,
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -h + 2],
  });
}

/**
 * A camera outline, shown through the image while it loads and instead of it
 * when there is nothing to load.
 *
 * A file gets its `position` child from `exif-extract` and its thumbnail later
 * from `media-stills`, so during a crawl a large share of geotagged media has a
 * marker and no picture yet. The
 * fallback is CSS rather than an `onerror` handler: the container paints the
 * glyph, and a failed `<img alt="">` collapses to nothing and reveals it.
 */
const PENDING_GLYPH = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ` +
    `stroke="rgba(255,255,255,.55)" stroke-width="1.5"><path d="M3 8h4l1.5-2h7L17 8h4v11H3z"/>` +
    `<circle cx="12" cy="13" r="3.5"/></svg>`,
);

/** The frame and the picture in it, waiting on a camera glyph until the thumbnail loads. */
const pictureHtml = (url: string, frame: string): string =>
  `<div style="position:relative;${frame}overflow:hidden;background:#3a3a3a ` +
  `url(&quot;data:image/svg+xml,${PENDING_GLYPH}&quot;) center/24px no-repeat">` +
  `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy"/></div>`;

const THUMB_FRAME = 'width:48px;height:48px;border-radius:6px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);';

export function thumbnailIcon(url: string): L.DivIcon {
  const html = pictureHtml(url, THUMB_FRAME);
  return L.divIcon({
    className: '',
    html,
    iconSize: [48, 48],
    iconAnchor: [24, 24],
    popupAnchor: [0, -26],
  });
}

/**
 * A pile of pictures as a marker: one of them in front, a second frame behind it, and how many
 * there are on a pill in its corner, so a map cell of many reads as more than the one shown.
 */
export function pileIcon(url: string, count: number | string): L.DivIcon {
  const html = `<div style="position:relative;width:48px;height:48px">` +
    `<div style="position:absolute;left:4px;top:-4px;${THUMB_FRAME}background:#2a2d34"></div>` +
    pictureHtml(url, THUMB_FRAME) +
    `<div style="position:absolute;right:-8px;top:-8px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;` +
    `background:rgba(10,11,14,.88);border:1.5px solid #fff;color:#fff;font:600 12px/19px sans-serif;text-align:center;` +
    `box-sizing:border-box">${count}</div></div>`;
  return L.divIcon({
    className: '',
    html,
    iconSize: [48, 48],
    iconAnchor: [24, 24],
    popupAnchor: [0, -26],
  });
}

export function clusterIcon(count: number | string, color = MARKER_COLOR): L.DivIcon {
  const style = `width:36px;height:36px;border-radius:50%;background:${color};color:#fff;` +
    `display:flex;align-items:center;justify-content:center;font:600 13px sans-serif;` +
    `border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)`;
  return L.divIcon({
    className: '',
    html: `<div style="${style}">${count}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

export function vertexIcon(primary = true): L.DivIcon {
  const size = primary ? 12 : 10;
  const style = `width:${size}px;height:${size}px;border-radius:50%;border:2px solid #fff;` +
    `background:${primary ? MARKER_COLOR : 'rgba(13,148,136,.5)'};box-shadow:0 0 3px rgba(0,0,0,.5)`;
  return L.divIcon({
    className: '',
    html: `<div style="${style}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}
