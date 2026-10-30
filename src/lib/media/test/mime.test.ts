import { assertEquals } from '@std/assert';
import {
  getMimeFromBuffer,
  getMimeFromExt,
  getMimeFromShebang,
  getMimeFromTextHeuristic,
  isRawExtension,
  isRawMimetype,
  isUntypedMimetype,
  MIME_DEFAULT_TYPE,
  RAW_IMAGE_EXTENSIONS,
  RAW_IMAGE_MIMETYPES,
  refineMimeByName,
} from '../mime.ts';

const enc = new TextEncoder();

Deno.test('mime detection', async (t) => {
  await t.step('detects png from magic bytes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    assertEquals(await getMimeFromBuffer(png), 'image/png');
  });

  await t.step('a shebang decides the type, through the buffer path too', async () => {
    // mime-bytes calls all of these text/plain; the shebang must still win
    assertEquals(await getMimeFromBuffer(enc.encode('#!/bin/sh\necho hi\n')), 'text/x-shellscript');
    assertEquals(await getMimeFromBuffer(enc.encode('#!bash\n\nalias ll="ls -al"\n')), 'text/x-shellscript');
    assertEquals(await getMimeFromBuffer(enc.encode('#!ts\nexport default 1;\n')), 'text/typescript');
    assertEquals(getMimeFromTextHeuristic(enc.encode('#!ts\r\nexport default 1;\r\n')), 'text/typescript');
  });

  await t.step('shebang interpreters: bare EiN names, host paths and env', () => {
    assertEquals(getMimeFromShebang('#!bash'), 'text/x-shellscript');
    assertEquals(getMimeFromShebang('#!/usr/bin/env bash'), 'text/x-shellscript');
    assertEquals(getMimeFromShebang('#!/usr/bin/env -S deno run -A'), 'text/typescript');
    assertEquals(getMimeFromShebang('#! /usr/bin/python3'), 'text/x-python');
    assertEquals(getMimeFromShebang('#!/usr/bin/env node'), 'text/javascript');
    // An interpreter we do not know is still a script
    assertEquals(getMimeFromShebang('#!/usr/bin/perl'), 'text/x-shellscript');
  });

  await t.step('untyped means absent, text/plain or octet-stream', () => {
    assertEquals(isUntypedMimetype(undefined), true);
    assertEquals(isUntypedMimetype(''), true);
    assertEquals(isUntypedMimetype('text/plain'), true);
    assertEquals(isUntypedMimetype(MIME_DEFAULT_TYPE), true);
    assertEquals(isUntypedMimetype('text/x-shellscript'), false);
    assertEquals(isUntypedMimetype('image/jpeg'), false);
  });

  await t.step('plain utf-8 content is text/plain', async () => {
    assertEquals(await getMimeFromBuffer(enc.encode('alias ll="ls -l"\nexport HISTSIZE=1000\nåäö émoji 🎉\n')), 'text/plain');
  });

  await t.step('text that begins like a binary signature is text', async () => {
    // "G" is mime-bytes' MPEG-TS, "BM" a bitmap, "ID3" an MP3, "MZ" an executable, "ftyp" at 4 an mp4
    for (const text of ['Garden party at the lake house. A sunny day', 'BMX race in the park', 'ID3 tags hold the title', 'MZ', 'The ftyp box comes first']) {
      assertEquals(await getMimeFromBuffer(enc.encode(text)), 'text/plain', text);
    }
    assertEquals(await getMimeFromBuffer(enc.encode('G'.repeat(600))), 'text/plain');
  });

  await t.step('a format that begins with text keeps its signature', async () => {
    assertEquals(await getMimeFromBuffer(enc.encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n')), 'application/pdf');
    assertEquals(await getMimeFromBuffer(enc.encode('{\\rtf1\\ansi\\deff0 {\\fonttbl}}')), 'application/rtf');
    assertEquals(await getMimeFromBuffer(enc.encode('<?xml version="1.0"?>\n<notes/>\n')), 'application/xml');
  });

  await t.step('binary content stays octet-stream', async () => {
    const bin = new Uint8Array([0x01, 0x00, 0xff, 0xfe, 0x00, 0x7f, 0x00, 0x9c]);
    assertEquals(await getMimeFromBuffer(bin), MIME_DEFAULT_TYPE);
  });

  await t.step('a text guess whose sample holds a NUL is bytes', async () => {
    // The first 32 bytes are ASCII, as a Fujifilm RAF's header is; the rest of the sample is not
    const bytes = new Uint8Array(256);
    bytes.set(enc.encode('FUJIFILMCCD-RAW 0201FF116501X-Pr'));
    assertEquals(await getMimeFromBuffer(bytes), MIME_DEFAULT_TYPE);
  });

  await t.step('UTF-16 text with a byte-order mark stays text despite its NULs', async () => {
    const text = 'hello world, this is text';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) bytes[2 + 2 * i] = text.charCodeAt(i);
    assertEquals(await getMimeFromBuffer(bytes), 'text/plain');
  });

  await t.step('Latin-1 text stays text', async () => {
    const bytes = Uint8Array.from('Hej p\xe5 dig, s\xe5 h\xe4r g\xe5r det till', (c) => c.charCodeAt(0));
    assertEquals(await getMimeFromBuffer(bytes), 'text/plain');
  });

  await t.step('empty content stays octet-stream', async () => {
    assertEquals(await getMimeFromBuffer(new Uint8Array(0)), MIME_DEFAULT_TYPE);
  });

  await t.step('heuristic tolerates a multi-byte char cut at the sample boundary', () => {
    // 513 bytes ending mid-way through a 2-byte UTF-8 char
    const bytes = new Uint8Array(513);
    bytes.fill(0x61); // 'a'
    bytes[511] = 0xc3; // first byte of 'å'
    bytes[512] = 0xa5; // second byte, outside the 512-byte sample
    assertEquals(getMimeFromTextHeuristic(bytes), 'text/plain');
  });

  await t.step('invalid utf-8 is not text', () => {
    const bytes = new Uint8Array([0x61, 0xc3, 0x28, 0x62]); // stray continuation
    assertEquals(getMimeFromTextHeuristic(bytes), undefined);
  });
});

/**
 * ISO-BMFF containers all start with the same `ftyp` box, so the 4-byte major brand at
 * offset 8 is the only thing in the sniff window that separates a still image from a
 * video from an audio-only file. Getting this wrong is not cosmetic: the stored mimetype
 * is what get-file sends as Content-Type, and a browser will not render an image it was
 * told is video/mp4.
 */
const ftyp = (brand: string, compatible = 'mif1'): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes.set([0x00, 0x00, 0x00, 0x20], 0); // box size
  bytes.set(enc.encode('ftyp'), 4);
  bytes.set(enc.encode(brand), 8);
  bytes.set(enc.encode(compatible), 16);
  return bytes;
};

Deno.test('ISO-BMFF brand detection', async (t) => {
  await t.step('avif is an image, not an mp4', async () => {
    // Every image derivative is AVIF. The upstream registry has no AVIF signature, so
    // without our own brand map these come back as video/mp4.
    assertEquals(await getMimeFromBuffer(ftyp('avif', 'avif')), 'image/avif');
    assertEquals(await getMimeFromBuffer(ftyp('avis', 'avis')), 'image/avif');
  });

  await t.step('audio-only mp4 brands are audio/mp4', async () => {
    // The audio rendition is written by ffmpeg's ipod muxer precisely to get this brand;
    // the mp4 muxer writes `isom` and the file reads as video.
    assertEquals(await getMimeFromBuffer(ftyp('M4A ', 'isom')), 'audio/mp4');
    assertEquals(await getMimeFromBuffer(ftyp('M4B ', 'isom')), 'audio/mp4');
    assertEquals(await getMimeFromBuffer(ftyp('M4P ', 'isom')), 'audio/mp4');
  });

  await t.step('a Canon CR3 is a RAW image, not an mp4', async () => {
    assertEquals(await getMimeFromBuffer(ftyp('crx ', 'crx ')), 'image/x-canon-cr3');
  });

  await t.step('an AV1 video is still video/mp4', async () => {
    assertEquals(await getMimeFromBuffer(ftyp('isom', 'av01')), 'video/mp4');
  });

  await t.step('heic/heif and quicktime resolve (regression: needs mime-bytes >= 0.30)', async () => {
    // The 8-byte `ftypheic` signature beats the generic 4-byte `ftyp`; otherwise a HEIC
    // upload is stored as video/mp4 and goes down the media pipeline's video branch.
    assertEquals(await getMimeFromBuffer(ftyp('heic', 'heic')), 'image/heic');
    assertEquals(await getMimeFromBuffer(ftyp('mif1', 'heic')), 'image/heif');
    assertEquals(await getMimeFromBuffer(ftyp('qt  ', 'qt  ')), 'video/quicktime');
  });

  await t.step('a header too short to hold a brand falls back to the container type', async () => {
    // The generic ftyp signature already matches at 8 bytes, so a buffer that stops before
    // the brand is complete must degrade to video/mp4 rather than read past the end
    assertEquals(await getMimeFromBuffer(ftyp('avif', 'avif').subarray(0, 11)), 'video/mp4');
  });
});

/** A transport-stream head of `count` PAT-like packets of `size` bytes, each behind `offset` bytes of timestamp. */
const transportStream = (size: number, offset: number, count: number): Uint8Array => {
  const bytes = new Uint8Array(size * count);
  for (let at = offset; at < bytes.length; at += size) {
    bytes.set([0x47, 0x40, 0x00, 0x10, 0x00], at);
    bytes.fill(0xff, at + 5, at + size - offset);
  }
  return bytes;
};

Deno.test('MPEG transport stream detection', async (t) => {
  await t.step('188-byte packets are a transport stream', async () => {
    assertEquals(await getMimeFromBuffer(transportStream(188, 0, 3)), 'video/mp2t');
  });

  await t.step('192-byte packets behind a timestamp are a transport stream', async () => {
    assertEquals(await getMimeFromBuffer(transportStream(192, 4, 3)), 'video/mp2t');
  });

  await t.step('a lone sync byte is not', async () => {
    const bytes = transportStream(188, 0, 3);
    bytes[376] = 0x00;
    assertEquals(await getMimeFromBuffer(bytes), MIME_DEFAULT_TYPE);
  });

  await t.step('a sample that holds one packet is not', async () => {
    assertEquals(await getMimeFromBuffer(transportStream(188, 0, 3).subarray(0, 32)), MIME_DEFAULT_TYPE);
  });
});

Deno.test('raw detection', async (t) => {
  await t.step('isRawMimetype recognizes camera RAW types', () => {
    assertEquals(isRawMimetype('image/x-canon-cr2'), true);
    assertEquals(isRawMimetype('image/x-nikon-nef'), true);
    assertEquals(isRawMimetype('image/x-adobe-dng'), true);
  });

  await t.step('isRawMimetype rejects normal/absent types', () => {
    assertEquals(isRawMimetype('image/jpeg'), false);
    assertEquals(isRawMimetype('image/tiff'), false);
    assertEquals(isRawMimetype(null), false);
    assertEquals(isRawMimetype(undefined), false);
  });

  await t.step('isRawExtension is case-insensitive on the filename', () => {
    assertEquals(isRawExtension('IMG_1.CR2'), true);
    assertEquals(isRawExtension(`/archive/albums/trip/photo.nef`), true);
    assertEquals(isRawExtension('photo.jpg'), false);
    assertEquals(isRawExtension('noext'), false);
  });

  await t.step('a RAW name decides over text, bytes or TIFF, and over nothing else', () => {
    assertEquals(refineMimeByName('image/tiff', 'DSC_0001.NEF'), 'image/x-nikon-nef');
    assertEquals(refineMimeByName('text/plain', 'DSCF0001.RAF'), 'image/x-fujifilm-raf');
    assertEquals(refineMimeByName(MIME_DEFAULT_TYPE, '/a/P1000001.RW2'), 'image/x-panasonic-rw2');
    assertEquals(refineMimeByName('image/jpeg', 'DSC_0001.NEF'), 'image/jpeg');
    assertEquals(refineMimeByName('image/x-nikon-nef', 'DSC_0001.NEF'), 'image/x-nikon-nef');
    assertEquals(refineMimeByName('image/tiff', 'scan.tif'), 'image/tiff');
    assertEquals(refineMimeByName('', 'DSC_0001.NEF'), '');
  });

  await t.step('a name lookup gives every RAW extension its RAW mimetype', async () => {
    for (const ext of RAW_IMAGE_EXTENSIONS) {
      assertEquals(RAW_IMAGE_MIMETYPES.has(await getMimeFromExt(`IMG.${ext.toUpperCase()}`)), true, ext);
    }
  });

  await t.step('the sniff takes the name into account when given one', async () => {
    const tiff = new Uint8Array(64);
    tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    assertEquals(await getMimeFromBuffer(tiff), 'image/tiff');
    assertEquals(await getMimeFromBuffer(tiff, 'DSC_0001.NEF'), 'image/x-nikon-nef');
    assertEquals(await getMimeFromBuffer(tiff, 'scan.tiff'), 'image/tiff');

    const raf = new Uint8Array(256);
    raf.set(enc.encode('FUJIFILMCCD-RAW 0201FF116501X-Pr'));
    assertEquals(await getMimeFromBuffer(raf, 'DSCF0001.RAF'), 'image/x-fujifilm-raf');
  });
});

Deno.test('sidecar names', async (t) => {
  await t.step('a sidecar name decides over a text or XML sniff, and over nothing else', () => {
    assertEquals(refineMimeByName('text/plain', 'IMG_0001.jpg.supplemental-metadata.json'), 'application/json');
    assertEquals(refineMimeByName('text/plain', '/home/anna/staging/files/IMG_0001.JSON'), 'application/json');
    assertEquals(refineMimeByName('text/plain', 'DSC_0001.xmp'), 'application/rdf+xml');
    assertEquals(refineMimeByName('application/xml', 'DSC_0001.XMP'), 'application/rdf+xml');
    // XML is no weak sniff for a `.json` name, and bytes are none for either
    assertEquals(refineMimeByName('application/xml', 'notes.json'), 'application/xml');
    assertEquals(refineMimeByName(MIME_DEFAULT_TYPE, 'notes.json'), MIME_DEFAULT_TYPE);
    assertEquals(refineMimeByName(MIME_DEFAULT_TYPE, 'DSC_0001.xmp'), MIME_DEFAULT_TYPE);
    assertEquals(refineMimeByName('image/jpeg', 'IMG_0001.json'), 'image/jpeg');
    assertEquals(refineMimeByName('text/plain', 'notes.txt'), 'text/plain');
  });

  await t.step('the sniff takes a sidecar name into account when given one', async () => {
    const json = enc.encode('{"title": "IMG_0001.jpg", "photoTakenTime": {"timestamp": "1500000000"}}\n');
    assertEquals(await getMimeFromBuffer(json), 'text/plain');
    assertEquals(await getMimeFromBuffer(json, 'IMG_0001.jpg.supplemental-metadata.json'), 'application/json');

    const packet = enc.encode('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>\n');
    assertEquals(await getMimeFromBuffer(packet, 'DSC_0001.xmp'), 'application/rdf+xml');
    const declared = enc.encode('<?xml version="1.0"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>\n');
    assertEquals(await getMimeFromBuffer(declared, 'DSC_0001.xmp'), 'application/rdf+xml');
  });

  await t.step('an extension that names an object member decides nothing', async () => {
    assertEquals(refineMimeByName('image/jpeg', 'a.constructor'), 'image/jpeg');
    assertEquals(refineMimeByName('text/plain', 'a.constructor'), 'text/plain');
    assertEquals(refineMimeByName('text/plain', 'A.TOSTRING'), 'text/plain');
    assertEquals(isRawExtension('a.hasOwnProperty'), false);
    assertEquals(await getMimeFromExt('a.constructor'), MIME_DEFAULT_TYPE);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    assertEquals(await getMimeFromBuffer(png, 'photo.constructor'), 'image/png');
  });
});

Deno.test('office document names', async (t) => {
  const zip = new Uint8Array(64);
  zip.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
  const ole = new Uint8Array(64);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  await t.step('a Compound File container sniffs as one', async () => {
    assertEquals(await getMimeFromBuffer(ole), 'application/x-ole-storage');
    assertEquals(await getMimeFromBuffer(ole, 'Thumbs.db'), 'application/x-ole-storage');
  });

  await t.step('an office name decides over the container its bytes are, and over nothing else', async () => {
    assertEquals(await getMimeFromBuffer(ole, 'letter.doc'), 'application/msword');
    assertEquals(await getMimeFromBuffer(ole, 'budget.XLS'), 'application/vnd.ms-excel');
    assertEquals(await getMimeFromBuffer(zip, 'letter.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assertEquals(await getMimeFromBuffer(zip, 'letter.odt'), 'application/vnd.oasis.opendocument.text');
    assertEquals(await getMimeFromBuffer(zip, 'photos.zip'), 'application/zip');
    assertEquals(await getMimeFromBuffer(zip, 'letter.doc'), 'application/zip');
    assertEquals(await getMimeFromBuffer(ole, 'letter.docx'), 'application/x-ole-storage');
    assertEquals(refineMimeByName(MIME_DEFAULT_TYPE, 'letter.doc'), MIME_DEFAULT_TYPE);
    assertEquals(refineMimeByName('text/plain', 'letter.docx'), 'text/plain');
  });
});
