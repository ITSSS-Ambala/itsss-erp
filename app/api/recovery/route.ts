import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { loadWorkspace, apiError, checkOrigin } from '../../../lib/server';
import { createRecoveryBackup, listRecoveryBackups, recoveryBackupFile, recoveryDirectory, restoreRecoveryBackup } from '../../../lib/hostinger/recovery';
import { maxRecoveryBytes, validateBackupPassword } from '../../../lib/hostinger/recovery-archive';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
function administrator(role: string) { if (!['Admin', 'Super Admin'].includes(role)) throw new Error('FORBIDDEN: Administrator access required.'); }
export async function GET(request: Request) {
  try {
    const { user } = await loadWorkspace(); administrator(user.role);
    const id = new URL(request.url).searchParams.get('download');
    if (!id) return Response.json({ backups: await listRecoveryBackups(), location: 'ERP_DATA_DIR/backups', maximumUploadBytes: maxRecoveryBytes }, { headers: { 'Cache-Control': 'private, no-store' } });
    const file = await recoveryBackupFile(id);
    return new Response(Readable.toWeb(createReadStream(file.filename)) as ReadableStream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Content-Disposition': `attachment; filename="${id}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  let upload: string | undefined;
  try {
    checkOrigin(request);
    const { user, revision } = await loadWorkspace(); administrator(user.role);
    if (request.headers.get('content-type')?.split(';')[0] === 'application/octet-stream') {
      const password = decodeURIComponent(request.headers.get('x-recovery-password') || ''); validateBackupPassword(password);
      if (request.headers.get('x-restore-confirmed') !== 'RESTORE') throw new Error('Confirm the full data restore before continuing.');
      if (request.headers.get('x-workspace-revision') !== String(revision)) throw new Error('CONFLICT: Refresh the workspace before restoring.');
      if (Number(request.headers.get('content-length')) > maxRecoveryBytes || !request.body) throw new Error('Choose a recovery archive smaller than 2 GB.');
      const directory = await recoveryDirectory(); await mkdir(directory, { recursive: true });
      upload = join(directory, `.upload-${crypto.randomUUID()}`);
      let size = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; callback(size > maxRecoveryBytes ? new Error('Recovery archive exceeds 2 GB.') : null, chunk); } });
      await pipeline(Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>), limiter, createWriteStream(upload, { flags: 'wx', mode: 0o600 }));
      const result = await restoreRecoveryBackup(upload, password, { expectedRevision: revision, actor: { id: user.userId, name: user.displayName } });
      return Response.json({ ...result, signInRequired: true }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const body = await request.json();
    if (!body || body.action !== 'create') throw new Error('Choose a recovery action.');
    validateBackupPassword(body.password);
    const backup = await createRecoveryBackup(body.password);
    return Response.json({ backup, backups: await listRecoveryBackups() }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return apiError(error); }
  finally { if (upload) await rm(upload, { force: true }); }
}
