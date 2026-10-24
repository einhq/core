/** An image's relative luminance, coarsened to `width` × `height` cells, row by row. */
export type LuminanceMap = { width: number; height: number; values: Float32Array };

/** Cells along an image's longer side: enough to tell a hat's patch of sky from the roof beside it. */
const CELLS = 64;

const cache = new Map<string, Promise<LuminanceMap | null>>();

/**
 * The relative luminance (WCAG's: 0 black, 1 white) of the image at `url`, in cells; null when it
 * does not load or cannot be read, as another origin's picture without CORS cannot. Kept for the
 * session.
 */
export function imageLuminance(url: string): Promise<LuminanceMap | null> {
  let found = cache.get(url);
  if (!found) {
    found = read(url);
    cache.set(url, found);
  }
  return found;
}

async function read(url: string): Promise<LuminanceMap | null> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    const scale = CELLS / Math.max(image.naturalWidth, image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = new OffscreenCanvas(width, height).getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const values = new Float32Array(width * height);
    for (let i = 0; i < values.length; i++) {
      values[i] = .2126 * linear(data[4 * i]) + .7152 * linear(data[4 * i + 1]) + .0722 * linear(data[4 * i + 2]);
    }
    return { width, height, values };
  } catch {
    return null;
  }
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
}

/**
 * The mean luminance within `radius` px of (`x`, `y`) in a `width` × `height` px box that `map`'s
 * image fills as `object-fit: cover` does, centred.
 */
export function luminanceAt(map: LuminanceMap, width: number, height: number, x: number, y: number, radius: number): number {
  const scale = Math.max(width / map.width, height / map.height);
  const left = (width - map.width * scale) / 2;
  const top = (height - map.height * scale) / 2;
  const cell = (at: number, offset: number, cells: number) => Math.min(cells - 1, Math.max(0, Math.floor((at - offset) / scale)));
  const fromX = cell(x - radius, left, map.width), toX = cell(x + radius, left, map.width);
  const fromY = cell(y - radius, top, map.height), toY = cell(y + radius, top, map.height);
  let sum = 0;
  for (let row = fromY; row <= toY; row++) {
    for (let col = fromX; col <= toX; col++) sum += map.values[row * map.width + col];
  }
  return sum / ((toX - fromX + 1) * (toY - fromY + 1));
}
