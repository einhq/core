import { extname } from '@std/path';

// Camera RAW image formats: each extension with the mimetype exiftool reports for it. This is
// the single place to extend RAW support. Content sniffing can't identify RAW (most are
// TIFF-based and sniff as image/tiff, a RAF opens with ASCII, others carry no signature the
// sniffer knows), so a RAW is told by its stored mimetype — set from the name at upload
// (`refineMimeByName`) and from exiftool in exif-extract — or by its file extension.
const RAW_IMAGE_MIMETYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['cr2', 'image/x-canon-cr2'],
  ['cr3', 'image/x-canon-cr3'],
  ['crw', 'image/x-canon-crw'],
  ['nef', 'image/x-nikon-nef'],
  ['nrw', 'image/x-nikon-nrw'],
  ['arw', 'image/x-sony-arw'],
  ['sr2', 'image/x-sony-sr2'],
  ['dng', 'image/x-adobe-dng'],
  ['orf', 'image/x-olympus-orf'],
  ['raf', 'image/x-fujifilm-raf'],
  ['rw2', 'image/x-panasonic-rw2'],
  ['raw', 'image/x-panasonic-raw'],
  ['pef', 'image/x-pentax-pef'],
  ['x3f', 'image/x-sigma-x3f'],
  ['mrw', 'image/x-minolta-mrw'],
  ['dcr', 'image/x-kodak-dcr'],
  ['kdc', 'image/x-kodak-kdc'],
  ['3fr', 'image/x-hasselblad-3fr'],
  ['iiq', 'image/x-phaseone-iiq'],
  ['erf', 'image/x-epson-erf'],
  ['srw', 'image/x-samsung-srw'],
  ['rwl', 'image/x-leica-rwl'],
]);

export const RAW_IMAGE_MIMETYPES: ReadonlySet<string> = new Set(RAW_IMAGE_MIMETYPE_BY_EXTENSION.values());

export const RAW_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(RAW_IMAGE_MIMETYPE_BY_EXTENSION.keys());

// What a sniff or exiftool calls a RAW whose format it does not recognise: text, bytes, or the
// TIFF container most RAW formats are built on.
const RAW_UNRECOGNISED_MIMETYPES: ReadonlySet<string> = new Set(['text/plain', 'application/octet-stream', 'image/tiff']);

/** True if the mimetype is a known camera RAW image format. */
export function isRawMimetype(mimetype: string | null | undefined): boolean {
  return mimetype != null && RAW_IMAGE_MIMETYPES.has(mimetype);
}

/** True if the filename's extension is a known camera RAW format (case-insensitive). */
export function isRawExtension(filename: string): boolean {
  return RAW_IMAGE_EXTENSIONS.has(extname(filename).slice(1).toLowerCase());
}

/** The RAW mimetype the filename's extension names (case-insensitive), or undefined for any other name. */
export function getRawMimeFromName(filename: string): string | undefined {
  return RAW_IMAGE_MIMETYPE_BY_EXTENSION.get(extname(filename).slice(1).toLowerCase());
}

// Sidecar names: each extension with its mimetype and the weak sniffs it decides over. A sniff
// reads a JSON or an XMP packet as text (an XMP that opens with an XML declaration as XML), and
// typed as text a sidecar would be taken for a document.
const SIDECAR_MIMETYPES_BY_EXTENSION: ReadonlyMap<string, { mimetype: string; over: ReadonlySet<string> }> = new Map([
  ['json', { mimetype: 'application/json', over: new Set(['text/plain']) }],
  ['xmp', { mimetype: 'application/rdf+xml', over: new Set(['text/plain', 'application/xml']) }],
]);

/**
 * The mimetype of a file called `filename` whose bytes were identified as `mimetype`, for the
 * names that decide over a weak sniff: a camera RAW name over text, bytes or TIFF, a `.json`
 * name over text, and an `.xmp` name over text or XML (case-insensitive). Any other answer, and
 * any other name, leaves `mimetype` as it is.
 */
export function refineMimeByName(mimetype: string, filename: string): string {
  const sidecar = SIDECAR_MIMETYPES_BY_EXTENSION.get(extname(filename).slice(1).toLowerCase());
  if (sidecar) return sidecar.over.has(mimetype) ? sidecar.mimetype : mimetype;
  if (!RAW_UNRECOGNISED_MIMETYPES.has(mimetype)) return mimetype;
  return getRawMimeFromName(filename) ?? mimetype;
}
