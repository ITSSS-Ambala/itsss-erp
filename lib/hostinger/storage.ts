import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getHostingerConfig } from './config.ts';
type Metadata = { key: string; size: number; httpMetadata: { contentType?: string }; customMetadata: Record<string, string> };
function locations(key: string) {
  if (!/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(key) || ['.', '..'].includes(key.split('/').at(-1)!)) throw new Error('Invalid file key.');
  const digest = createHash('sha256').update(key).digest('hex');
  const folder = join(getHostingerConfig().dataDirectory, 'files', digest.slice(0, 2));
  return { folder, bytes: join(folder, `${digest}.bin`), metadata: join(folder, `${digest}.json`) };
}
async function head(key: string): Promise<Metadata | null> {
  const files = locations(key);
  try {
    const metadata = JSON.parse(await readFile(files.metadata, 'utf8')) as Metadata;
    if (metadata.key !== key || (await stat(files.bytes)).size !== metadata.size) throw new Error('File storage metadata is inconsistent.');
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export const privateBucket = {
  head,
  async put(key: string, body: ReadableStream<Uint8Array>, options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {}) {
    const files = locations(key);
    await mkdir(files.folder, { recursive: true, mode: 0o700 });
    if (await head(key)) throw new Error('A file with this key already exists.');
    const temporary = `${files.bytes}.${randomUUID()}.tmp`;
    const temporaryMetadata = `${files.metadata}.${randomUUID()}.tmp`;
    let total = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(total > 100 * 1024 * 1024 ? new Error('File exceeds the maximum upload size.') : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const metadata: Metadata = { key, size: total, httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} };
      await writeFile(temporaryMetadata, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      await rename(temporary, files.bytes);
      await rename(temporaryMetadata, files.metadata);
    } finally { await Promise.all([rm(temporary, { force: true }), rm(temporaryMetadata, { force: true })]); }
  },
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const metadata = await head(key);
    if (!metadata) return null;
    const files = locations(key);
    const range = options?.range;
    if (range && (!Number.isInteger(range.offset) || !Number.isInteger(range.length) || range.offset < 0 || range.length <= 0 || range.offset + range.length > metadata.size)) throw new Error('Invalid file range.');
    return {
      ...metadata,
      get body() { return Readable.toWeb(createReadStream(files.bytes, range ? { start: range.offset, end: range.offset + range.length - 1 } : undefined)) as ReadableStream<Uint8Array>; },
      async arrayBuffer(): Promise<ArrayBuffer> {
        const bytes = await readFile(files.bytes);
        const selected = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
        return Uint8Array.from(selected).buffer;
      },
    };
  },
};
