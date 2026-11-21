const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** The elements a guide diagram is drawn with: shapes, text, markers and gradients. */
const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'marker',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'path',
  'line',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'text',
  'tspan',
]);

/** Geometry and presentation attributes; no href, event handler or style among them. */
const ATTRIBUTES = new Set([
  'viewBox',
  'preserveAspectRatio',
  'id',
  'transform',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'dx',
  'dy',
  'd',
  'points',
  'width',
  'height',
  'offset',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'vector-effect',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'gradientUnits',
  'gradientTransform',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
]);

/**
 * An SVG diagram from the guide, rebuilt in `doc` from what a diagram needs and nothing else: the
 * elements and attributes listed above, and text. Anything else is dropped with what it holds:
 * scripts, handlers, links, animations, styles, comments and processing instructions. Since it is
 * built as nodes, never parsed again as HTML, nothing in the source can become markup of the page.
 * Its ids are prefixed so two diagrams on a page keep their own gradients and markers, and a
 * `url(…)` reaches only one of them; its own size is given up to the page's CSS, and it is labelled
 * for a screen reader. Null when the source is not an SVG document.
 */
export function guideSvg(source: string, doc: Document, prefix: string, label: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg' || parsed.querySelector('parsererror')) return null;
  const ids = new Set([...root.querySelectorAll('[id]')].map((element) => element.id));

  const value = (name: string, raw: string): string | null => {
    if (name === 'id') return ids.has(raw) ? `${prefix}-${raw}` : null;
    if (!/url\s*\(/i.test(raw)) return raw;
    const local = /^\s*url\(\s*#([^)\s]+)\s*\)\s*$/.exec(raw);
    return local && ids.has(local[1]) ? `url(#${prefix}-${local[1]})` : null;
  };

  const copy = (from: Element): Element => {
    const to = doc.createElementNS(SVG_NS, from.localName);
    for (const attribute of from.attributes) {
      if (attribute.namespaceURI === XML_NS && attribute.localName === 'space') {
        to.setAttributeNS(XML_NS, 'xml:space', attribute.value === 'preserve' ? 'preserve' : 'default');
        continue;
      }
      if (attribute.namespaceURI !== null || !ATTRIBUTES.has(attribute.localName)) continue;
      const kept = value(attribute.localName, attribute.value);
      if (kept !== null) to.setAttribute(attribute.localName, kept);
    }
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
        to.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        if (element.namespaceURI === SVG_NS && ELEMENTS.has(element.localName) && element.localName !== 'svg') to.appendChild(copy(element));
      }
    }
    return to;
  };

  const svg = copy(root) as SVGSVGElement;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  return svg;
}
