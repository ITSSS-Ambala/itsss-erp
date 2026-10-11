import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

const magic = Buffer.from('ITSSS-RECOVERY-1\n');
const headerSize = magic.length + 16 + 12;
export const maxRecoveryBytes = 2 * 1024 ** 3;
const maxExpandedBytes = 4 * 1024 ** 3;
export type ArchiveFile = { path: string; filename: string; size: number };

export function validateBackupPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 256) throw new Error('Use a backup password of at least 12 characters and at most 256 bytes.');
}
async function keyFor(password: string, salt: Buffer): Promise<Buffer> {
  validateBackupPassword(password);
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) => error ? reject(error) : resolve(key)));
}
function validPath(path: string) {
  if (!path || path.length > 1024 || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid path in recovery archive.');
  if (path !== 'manifest.json' && path !== 'workspace.sqlite' && !/^files\/[a-f0-9]{2}\/[a-f0-9]{64}\.(bin|json)$/.test(path) && !path.startsWith('application/')) throw new Error('Unexpected file in recovery archive.');
  if (path.startsWith('application/') && path.split('/').some(part => /^\.env/.test(part) && part !== '.env.example' || ['.git', '.aws', '.codex', '.agents', 'outputs', '.erp-data', '.dev.vars'].includes(part))) throw new Error('Private configuration must only appear inside the encrypted manifest.');
}
export async function writeRecoveryArchive(filename: string, files: ArchiveFile[], password: string) {
  const salt = randomBytes(16), iv = randomBytes(12), key = await keyFor(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  key.fill(0);
  let total = 0;
  async function* payload() {
    for (const file of files) {
      validPath(file.path);
      total += file.size;
      if (total > maxExpandedBytes) throw new Error('Recovery data exceeds the 4 GB archive limit.');
      const metadata = Buffer.from(JSON.stringify({ path: file.path, size: file.size })), length = Buffer.alloc(4);
      length.writeUInt32BE(metadata.length);
      yield length; yield metadata;
      const digest = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(file.filename)) { const bytes = chunk as Buffer; size += bytes.length; digest.update(bytes); yield bytes; }
      if (size !== file.size) throw new Error('A file changed while backing up. Please retry.');
      yield digest.digest();
    }
    yield Buffer.alloc(4);
  }
  const temporary = `${filename}.tmp`;
  try {
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    output.write(Buffer.concat([magic, salt, iv]));
    await pipeline(Readable.from(payload()), createGzip(), cipher, output);
    await appendFile(temporary, cipher.getAuthTag());
    if ((await lstat(temporary)).size > maxRecoveryBytes) throw new Error('Compressed recovery archive exceeds 2 GB.');
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const { rename } = await import('node:fs/promises');
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

class Bytes {
  private iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  constructor(stream: AsyncIterable<Buffer>) { this.iterator = stream[Symbol.asyncIterator](); }
  async take(size: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let left = size;
    while (left) {
      if (!this.pending.length) {
        const result = await this.iterator.next();
        if (result.done) throw new Error('Truncated recovery archive.');
        this.pending = result.value;
      }
      const count = Math.min(left, this.pending.length);
      chunks.push(this.pending.subarray(0, count)); this.pending = this.pending.subarray(count); left -= count;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
  }
  async end() { if (this.pending.length || !(await this.iterator.next()).done) throw new Error('Unexpected trailing recovery data.'); }
}

/** Authenticate the entire ciphertext before decompressing or extracting anything. */
export async function extractRecoveryArchive(filename: string, directory: string, password: string, options: { skipApplication?: boolean } = {}): Promise<string[]> {
  const file = await lstat(filename);
  if (!file.isFile() || file.isSymbolicLink() || file.size > maxRecoveryBytes || file.size < headerSize + 16) throw new Error('Choose a valid recovery archive (maximum 2 GB).');
  const handle = await open(filename, 'r');
  const header = Buffer.alloc(headerSize), tag = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); await handle.read(tag, 0, 16, file.size - 16); } finally { await handle.close(); }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Choose an ITSSS .itsss-backup recovery archive.');
  const key = await keyFor(password, header.subarray(magic.length, magic.length + 16));
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length + 16));
  key.fill(0); decipher.setAuthTag(tag);
  const compressed = join(directory, 'authenticated.gz');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    try { await pipeline(createReadStream(filename, { start: headerSize, end: file.size - 17 }), decipher, createWriteStream(compressed, { flags: 'wx', mode: 0o600 })); }
    catch { throw new Error('The backup password is incorrect or the recovery archive is damaged.'); }
    const gunzip = createGunzip(), source = createReadStream(compressed);
    // pipeline forwards both I/O and decompression errors to the async iterator.
    const decompression = pipeline(source, gunzip).catch(error => { gunzip.destroy(error); });
    const reader = new Bytes(gunzip), paths = new Set<string>(); let total = 0;
    try {
      while (true) {
        const length = (await reader.take(4)).readUInt32BE();
        if (!length) break;
        if (length > 4096 || paths.size >= 100000) throw new Error('Invalid recovery archive entry.');
        const entry = JSON.parse((await reader.take(length)).toString('utf8')) as { path: string; size: number };
        if (typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid recovery archive entry.');
        validPath(entry.path);
        if (paths.has(entry.path)) throw new Error('Duplicate path in recovery archive.');
        paths.add(entry.path); total += entry.size;
        if (total > maxExpandedBytes || entry.path === 'manifest.json' && entry.size > 1024 ** 2) throw new Error('Recovery archive exceeds its data limit.');
        const destination = join(directory, 'contents', ...entry.path.split('/'));
        const skip = options.skipApplication && entry.path.startsWith('application/');
        if (!skip) await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const output = skip ? undefined : await open(destination, 'wx', 0o600), digest = createHash('sha256'); let left = entry.size;
        try {
          while (left) { const bytes = await reader.take(Math.min(left, 64 * 1024)); digest.update(bytes); if (output) await output.writeFile(bytes); left -= bytes.length; }
        } finally { await output?.close(); }
        if (!(await reader.take(32)).equals(digest.digest())) throw new Error('Recovery file checksum mismatch.');
      }
      await reader.end();
      return [...paths];
    } finally { source.destroy(); gunzip.destroy(); await decompression; }
  } finally { await rm(compressed, { force: true }); }
}
