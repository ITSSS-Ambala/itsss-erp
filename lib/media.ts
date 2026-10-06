export type MediaPurpose = 'timeline' | 'logo' | 'document';
export type MediaKind = 'image' | 'video' | 'audio' | 'document';
export type MediaFile = Blob & { name?: string };
export type MediaValidation = { contentType: string; kind: MediaKind; inlineAllowed: boolean };
export type ByteRange = { start: number; end: number; length: number };

const MB = 1024 * 1024;
const formats: Record<string, { kind: Exclude<MediaKind, 'document'>; extensions: string[] }> = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
  'image/avif': { kind: 'image', extensions: ['avif'] },
  'video/mp4': { kind: 'video', extensions: ['mp4', 'm4v'] },
  'video/webm': { kind: 'video', extensions: ['webm'] },
  'video/quicktime': { kind: 'video', extensions: ['mov', 'qt'] },
  'audio/mpeg': { kind: 'audio', extensions: ['mp3'] },
  'audio/wav': { kind: 'audio', extensions: ['wav'] },
  'audio/ogg': { kind: 'audio', extensions: ['ogg', 'oga', 'opus'] },
  'audio/mp4': { kind: 'audio', extensions: ['m4a'] },
  'audio/aac': { kind: 'audio', extensions: ['aac'] },
};
const aliases: Record<string, string> = {
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4', 'video/x-m4v': 'video/mp4',
};
const mime = (type: string) => {
  const value = String(type || '').split(';', 1)[0].trim().toLowerCase();
  return aliases[value] || value;
};
const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
const starts = (bytes: Uint8Array, values: number[]) => values.every((value, index) => bytes[index] === value);
const uint32 = (bytes: Uint8Array, at: number) => bytes.length < at + 4 ? 0 : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);

function brands(bytes: Uint8Array, size: number): string[] {
  const boxSize = uint32(bytes, 0);
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp' || boxSize < 16 || boxSize > size || boxSize % 4) return [];
  const result = [ascii(bytes, 8, 4)];
  for (let at = 16; at + 4 <= Math.min(boxSize, bytes.length); at += 4) result.push(ascii(bytes, at, 4));
  return result;
}

function matchesSignature(type: string, bytes: Uint8Array, size: number): boolean {
  if (type === 'image/png') return bytes.length >= 24 && starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) && ascii(bytes, 12, 4) === 'IHDR' && uint32(bytes, 16) > 0 && uint32(bytes, 20) > 0;
  if (type === 'image/jpeg') return bytes.length >= 4 && starts(bytes, [255, 216, 255]) && bytes[3] !== 0 && bytes[3] !== 255;
  if (type === 'image/gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) && (bytes[6] || bytes[7]) > 0 && (bytes[8] || bytes[9]) > 0;
  if (type === 'image/webp') return bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4));
  if (type === 'image/avif') return brands(bytes, size).some(brand => ['avif', 'avis'].includes(brand));
  if (type === 'video/mp4') return brands(bytes, size).some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash'].includes(brand)) && !brands(bytes, size).some(brand => ['avif', 'avis', 'M4A ', 'M4B '].includes(brand));
  if (type === 'video/quicktime') {
    if (brands(bytes, size).includes('qt  ')) return true;
    // Older QuickTime files may begin with a movie/media atom rather than ftyp.
    return bytes.length >= 12 && uint32(bytes, 0) >= 8 && uint32(bytes, 0) <= size && ['moov', 'mdat', 'wide'].includes(ascii(bytes, 4, 4));
  }
  if (type === 'video/webm') return starts(bytes, [26, 69, 223, 163]) && ascii(bytes, 4, bytes.length - 4).includes('webm');
  if (type === 'audio/wav') return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
  if (type === 'audio/ogg') return bytes.length >= 28 && ascii(bytes, 0, 4) === 'OggS' && bytes[4] === 0 && ['OpusHead', 'vorbis', 'Speex   ', 'FLAC'].some(codec => ascii(bytes, 27, bytes.length - 27).includes(codec));
  if (type === 'audio/mp4') return brands(bytes, size).some(brand => ['M4A ', 'M4B ', 'isom', 'mp41', 'mp42'].includes(brand)) && !brands(bytes, size).some(brand => ['avif', 'avis'].includes(brand));
  if (type === 'audio/mpeg') {
    if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'ID3' && [2, 3, 4].includes(bytes[3]) && bytes.slice(6, 10).every(byte => byte < 128)) {
      const tagLength = bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9];
      return tagLength + 10 <= size;
    }
    return bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] & 24) !== 8 && (bytes[1] & 6) === 2 && (bytes[2] >> 4) > 0 && (bytes[2] >> 4) < 15 && (bytes[2] & 12) !== 12;
  }
  if (type === 'audio/aac') {
    if (bytes.length < 7 || bytes[0] !== 255 || (bytes[1] & 246) !== 240 || ((bytes[2] >> 2) & 15) > 12) return false;
    const frameLength = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
    return frameLength >= 7 && frameLength <= size;
  }
  return false;
}

/** Validate the advertised media format against a small byte prefix; this is not full codec decoding. */
export async function validateMediaUpload(file: MediaFile, purpose: MediaPurpose = 'document'): Promise<MediaValidation> {
  if (!['timeline', 'logo', 'document'].includes(purpose)) throw new Error('Unknown upload purpose.');
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Choose a nonempty file.');
  const advertised = mime(file.type);
  const extension = file.name ? file.name.split('.').pop()!.toLowerCase() : '';
  const inferred = Object.keys(formats).find(type => formats[type].extensions.includes(extension));
  const type = !advertised || advertised === 'application/octet-stream' ? inferred || '' : advertised;
  const format = formats[type];
  const limit = purpose === 'logo' ? 5 * MB : purpose === 'timeline' && format?.kind === 'video' ? 100 * MB : 20 * MB;
  if (file.size > limit) throw new Error(`Choose a file up to ${limit / MB} MB.`);
  if (!format) {
    if (purpose !== 'document') throw new Error('Choose a supported photo, video or audio file.');
    // Ordinary document attachments remain supported, but cannot become active inline content.
    return { contentType: 'application/octet-stream', kind: 'document', inlineAllowed: false };
  }
  if (purpose === 'logo' && (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type))) throw new Error('Choose a PNG, JPEG, WebP or GIF logo.');
  if (file.name && !format.extensions.includes(extension)) throw new Error('The filename extension does not match its media type.');
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (!matchesSignature(type, bytes, file.size)) throw new Error('The file contents do not match its media type.');
  return { contentType: type, kind: format.kind, inlineAllowed: true };
}

/** Recheck authoritative storage metadata when linking a previously uploaded company logo. */
export function validateLogoMetadata(file: { size: number; httpMetadata?: { contentType?: string } }): void {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 5 * MB) throw new Error('Choose a logo between 1 byte and 5 MB.');
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime(file.httpMetadata?.contentType || ''))) throw new Error('Choose a PNG, JPEG, WebP or GIF logo.');
}

export class MediaRangeError extends RangeError {
  readonly status = 416;
  readonly contentRange: string;
  constructor(size: number) {
    super('Requested byte range is invalid or unsatisfiable.');
    this.name = 'MediaRangeError';
    this.contentRange = `bytes */${size}`;
  }
}

/** Only a single RFC 9110 byte range is supported; invalid/multipart requests receive 416. */
export function parseByteRange(header: string | null, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size.');
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || header.length > 256 || !size || (!match[1] && !match[2])) throw new MediaRangeError(size);
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix <= 0) throw new MediaRangeError(size);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || start >= size || start > end) throw new MediaRangeError(size);
  }
  return { start, end, length: end - start + 1 };
}

export function fileResponseHeaders({ contentType, name, size, inline = false, range }: { contentType: string; name: string; size: number; inline?: boolean; range?: ByteRange | null }): Headers {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size.');
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end >= size || range.end < range.start || range.length !== range.end - range.start + 1)) throw new MediaRangeError(size);
  const candidate = mime(contentType), type = formats[candidate] ? candidate : 'application/octet-stream';
  const filename = String(name || 'document').replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200).toWellFormed();
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const headers = new Headers({
    'Content-Type': type,
    'Content-Disposition': `${inline && formats[candidate] ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Content-Length': String(range ? range.length : size),
    'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
  });
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  return headers;
}
