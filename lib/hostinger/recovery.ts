import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { runtimeDatabase, closeRuntimeDatabase, initializeDatabase } from './database.ts';
import { getHostingerConfig } from './config.ts';
import { activeFileWrites } from './storage.ts';
import { extractRecoveryArchive, writeRecoveryArchive, validateBackupPassword, type ArchiveFile } from './recovery-archive.ts';
import { installRecoveredData } from './restore-install.ts';
import { openVault, sealVault } from '../vault.ts';
import { resolveRole } from '../access.ts';
import { validPasswordHash } from './password.ts';
import type { Store } from '../schema.ts';

const archiveName = /^(backup|safety)-\d{8}T\d{6}Z-[a-f0-9-]{36}\.itsss-backup$/;
const columns: Record<string, string[]> = {
  erp_workspace: ['id', 'data', 'revision', 'updated_at'],
  erp_workspace_migrations: ['workspace_id', 'migration', 'revision', 'data', 'created_at'],
  auth_passwords: ['member_id', 'password_hash', 'configuration_hash'],
  notification_reads: ['member_id', 'notification_id', 'read_at'],
  notification_clears: ['member_id', 'notification_id', 'cleared_at'],
};
type Manifest = { format: 'itsss-recovery-v1'; createdAt: string; revision: number; application: 'source' | 'runtime' | 'none'; configuration: Record<string, string>; entries: number };
export type RecoveryBackup = { id: string; size: number; createdAt: string; safety: boolean };
let recovering = false;

async function exists(filename: string) { try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function recoveryDirectory() {
  const directory = join(getHostingerConfig().dataDirectory, 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Recovery storage must be a private directory, not a symbolic link.');
  return directory;
}
export async function recoveryBackupFile(id: string) {
  if (!archiveName.test(id)) throw new Error('Choose a saved recovery backup.');
  const filename = join(await recoveryDirectory(), id), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid recovery backup file.');
  return { filename, size: info.size };
}
export async function listRecoveryBackups(): Promise<RecoveryBackup[]> {
  const directory = await recoveryDirectory(), backups: RecoveryBackup[] = [];
  for (const id of await readdir(directory)) if (archiveName.test(id)) {
    const info = await lstat(join(directory, id));
    if (info.isFile() && !info.isSymbolicLink()) backups.push({ id, size: info.size, createdAt: info.mtime.toISOString(), safety: id.startsWith('safety-') });
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function walk(directory: string, prefix: string, files: ArchiveFile[], applicationRoot?: string, ancestors = new Set<string>()) {
  const actual = await realpath(directory);
  if (applicationRoot) { const fromRoot = relative(applicationRoot, actual); if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Application recovery directories must stay inside the application directory.'); }
  if ((await lstat(directory)).isSymbolicLink() && !applicationRoot) throw new Error('Recovery data directories must not be symbolic links.');
  if (ancestors.has(actual)) throw new Error('Circular application link in recovery files.');
  const seen = new Set([...ancestors, actual]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name), path = `${prefix}/${entry.name}`;
    let info: { isDirectory(): boolean; isFile(): boolean } = entry;
    if (entry.isSymbolicLink()) {
      if (!applicationRoot) throw new Error('Recovery data cannot include symbolic links.');
      const target = await realpath(filename), fromRoot = relative(applicationRoot, target);
      if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Application recovery links must stay inside the application directory.');
      info = await stat(filename);
    }
    if (info.isDirectory()) await walk(filename, path, files, applicationRoot, seen);
    else if (info.isFile() && !entry.name.endsWith('.tmp')) files.push({ filename, path, size: (await stat(filename)).size });
  }
}
async function applicationFiles(root: string, files: ArchiveFile[]): Promise<Manifest['application']> {
  const applicationRoot = await realpath(root);
  if (await exists(join(root, 'app', 'erp-app.tsx'))) {
    for (const directory of ['app', 'components', 'hooks', 'lib', 'public', 'tests', 'docs', 'scripts', 'db', 'drizzle']) if (await exists(join(root, directory))) await walk(join(root, directory), `application/${directory}`, files, applicationRoot);
    for (const name of ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'eslint.config.mjs', 'components.json', 'drizzle.config.ts', '.env.example', 'README.md']) if (await exists(join(root, name))) files.push({ filename: join(root, name), path: `application/${name}`, size: (await stat(join(root, name))).size });
    return 'source';
  }
  if (await exists(join(root, 'server.js')) && await exists(join(root, '.next'))) {
    for (const directory of ['.next', 'node_modules', 'public', 'recovery-tool']) if (await exists(join(root, directory))) await walk(join(root, directory), `application/${directory}`, files, applicationRoot);
    for (const name of ['server.js', 'package.json']) if (await exists(join(root, name))) files.push({ filename: join(root, name), path: `application/${name}`, size: (await stat(join(root, name))).size });
    return 'runtime';
  }
  return 'none';
}
export async function createRecoveryBackup(password: string, options: { safety?: boolean; applicationRoot?: string } = {}): Promise<RecoveryBackup & { application: Manifest['application']; revision: number }> {
  validateBackupPassword(password);
  const config = getHostingerConfig(), directory = await recoveryDirectory(), temporary = await mkdtemp(join(directory, '.snapshot-'));
  const createdAt = new Date().toISOString(), id = `${options.safety ? 'safety' : 'backup'}-${createdAt.replace(/[-:]/g, '').slice(0, 15)}Z-${randomUUID()}.itsss-backup`;
  try {
    const snapshot = join(temporary, 'workspace.sqlite');
    runtimeDatabase().prepare('VACUUM INTO ?').run(snapshot);
    const database = new DatabaseSync(snapshot, { readOnly: true });
    let revision: number, snapshotStore: Store;
    try { const row = database.prepare('SELECT revision, data FROM erp_workspace WHERE id = ?').get('main'); if (!row) throw new Error('Initialize the workspace before creating a recovery backup.'); revision = Number(row.revision); snapshotStore = JSON.parse(String(row.data)); validateStore(snapshotStore); } finally { database.close(); }
    const files: ArchiveFile[] = [{ path: 'workspace.sqlite', filename: snapshot, size: (await stat(snapshot)).size }];
    if (await exists(join(config.dataDirectory, 'files'))) {
      await walk(join(config.dataDirectory, 'files'), 'files', files);
      // Incomplete uploads are not database references and must not enter the snapshot.
      const complete = new Set(files.map(file => file.path));
      for (let i = files.length - 1; i >= 0; i--) if (files[i].path.startsWith('files/') && !complete.has(files[i].path.replace(/\.(bin|json)$/, files[i].path.endsWith('.bin') ? '.json' : '.bin'))) files.splice(i, 1);
    }
    await validatePrivateFiles(config.dataDirectory, files.map(file => file.path), await openVault(snapshotStore, config.vaultKey));
    const application = await applicationFiles(resolve(options.applicationRoot || process.cwd()), files);
    const configuration = {
      ERP_PUBLIC_URL: config.origin, ERP_ADMIN_EMAIL: config.ownerEmail, ERP_ADMIN_NAME: config.accounts[0].name,
      ERP_ADMIN_PASSWORD_HASH: config.accounts[0].passwordHash, ERP_VAULT_KEY: config.vaultKey,
      ERP_SESSION_HOURS: String(config.sessionSeconds / 3600), ERP_AUTH_USERS: JSON.stringify(config.accounts.slice(1)),
    };
    const manifest: Manifest = { format: 'itsss-recovery-v1', createdAt, revision, application, configuration, entries: files.length + 1 };
    const manifestPath = join(temporary, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    files.unshift({ path: 'manifest.json', filename: manifestPath, size: (await stat(manifestPath)).size });
    await writeRecoveryArchive(join(directory, id), files, password);
    return { id, createdAt, size: (await stat(join(directory, id))).size, safety: Boolean(options.safety), application, revision };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function validateStore(value: unknown): asserts value is Store {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace in recovery database.');
  for (const [module, rows] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(module) || !Array.isArray(rows)) throw new Error('Invalid workspace module in recovery database.');
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Invalid or duplicate record in recovery database.');
      ids.add(row.id);
    }
  }
}
async function validatePrivateFiles(contents: string, paths: string[], store: Store) {
  const present = new Set(paths), keys = new Set<string>();
  for (const path of paths.filter(path => /^files\/.+\.json$/.test(path))) {
    if ((await stat(join(contents, path))).size > 1024 ** 2) throw new Error('Invalid file metadata in recovery archive.');
    const metadata = JSON.parse(await readFile(join(contents, path), 'utf8'));
    if (typeof metadata.key !== 'string' || !/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(metadata.key)) throw new Error('Invalid private file key in recovery archive.');
    const digest = createHash('sha256').update(metadata.key).digest('hex'), expected = `files/${digest.slice(0, 2)}/${digest}.json`, binary = expected.replace(/\.json$/, '.bin');
    if (expected !== path || !present.has(binary) || !Number.isSafeInteger(metadata.size) || (await stat(join(contents, binary))).size !== metadata.size) throw new Error('Incomplete or inconsistent uploaded file in recovery archive.');
    keys.add(metadata.key);
  }
  for (const path of paths.filter(path => /^files\/.+\.bin$/.test(path))) if (!present.has(path.replace(/\.bin$/, '.json'))) throw new Error('Missing uploaded file metadata in recovery archive.');
  const check = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(check); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.key === 'string' && object.key.startsWith('files/') && !keys.has(object.key)) throw new Error('The backup is missing an uploaded file referenced by a record.');
    Object.values(object).forEach(check);
  };
  // Historical audit payloads are strings; only actual record attachment references are checked.
  for (const [module, rows] of Object.entries(store)) if (!['auditLogs', 'activities', 'notifications', 'vault'].includes(module)) check(rows);
  await mkdir(join(contents, 'files'), { recursive: true, mode: 0o700 });
}

export async function restoreRecoveryBackup(filename: string, password: string, options: { expectedRevision?: number; offline?: boolean; dataDirectory?: string; applicationDirectory?: string; actor?: { id: string; name: string } } = {}) {
  validateBackupPassword(password);
  if (recovering) throw new Error('CONFLICT: A recovery operation is already in progress.');
  const dataDirectory = resolve(options.dataDirectory || getHostingerConfig().dataDirectory), stage = `.restore-${randomUUID()}`, directory = join(dataDirectory, 'backups', stage);
  if (dataDirectory.split(/[\\/]/).some(part => ['public_html', 'hbuilds'].includes(part.toLowerCase()))) throw new Error('Restore data to a private directory outside public_html and hbuilds.');
  recovering = true;
  let keepStage = false;
  try {
    await mkdir(join(dataDirectory, 'backups'), { recursive: true, mode: 0o700 });
    if ((await lstat(join(dataDirectory, 'backups'))).isSymbolicLink()) throw new Error('Recovery storage must not be a symbolic link.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths = await extractRecoveryArchive(filename, directory, password, { skipApplication: !options.applicationDirectory }), contents = join(directory, 'contents');
    if (!paths.includes('manifest.json') || !paths.includes('workspace.sqlite')) throw new Error('Recovery archive is missing its manifest or SQLite database.');
    const manifest = JSON.parse(await readFile(join(contents, 'manifest.json'), 'utf8')) as Manifest;
    if (manifest.format !== 'itsss-recovery-v1' || !['source', 'runtime', 'none'].includes(manifest.application) || manifest.entries !== paths.length || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 || !manifest.configuration || !validPasswordHash(manifest.configuration.ERP_ADMIN_PASSWORD_HASH) || !manifest.configuration.ERP_ADMIN_EMAIL || Buffer.from(manifest.configuration.ERP_VAULT_KEY || '', 'base64').length !== 32) throw new Error('Invalid recovery manifest.');
    const configuration: Record<string, string> = {};
    for (const key of ['ERP_PUBLIC_URL', 'ERP_ADMIN_EMAIL', 'ERP_ADMIN_NAME', 'ERP_ADMIN_PASSWORD_HASH', 'ERP_VAULT_KEY', 'ERP_SESSION_HOURS', 'ERP_AUTH_USERS']) {
      if (typeof manifest.configuration[key] !== 'string') throw new Error('Invalid recovery configuration.');
      configuration[key] = manifest.configuration[key];
    }
    const source = new DatabaseSync(join(contents, 'workspace.sqlite'), { readOnly: true });
    let sealed: Store, savedTables: Record<string, Record<string, SQLInputValue>[]>;
    try {
      if (source.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('The recovery database is damaged.');
      for (const row of source.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()) if (row.type !== 'table' || ![...Object.keys(columns), 'auth_sessions', 'auth_attempts'].includes(String(row.name))) throw new Error('Unexpected schema in recovery database.');
      const main = source.prepare('SELECT data, revision FROM erp_workspace WHERE id = ?').get('main');
      if (!main || main.revision !== manifest.revision) throw new Error('Recovery database does not match its manifest.');
      sealed = JSON.parse(String(main.data)); validateStore(sealed);
      savedTables = {};
      for (const [table, fields] of Object.entries(columns)) {
        const exists = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        savedTables[table] = exists ? source.prepare(`SELECT ${fields.join(',')} FROM ${table}`).all() as Record<string, SQLInputValue>[] : [];
      }
      for (const row of savedTables.auth_passwords) if (!validPasswordHash(String(row.password_hash))) throw new Error('Invalid password record in recovery database.');
    } finally { source.close(); }
    const restored = await openVault(sealed!, configuration.ERP_VAULT_KEY);
    await validatePrivateFiles(contents, paths, restored);
    const config = options.offline ? undefined : getHostingerConfig();
    const ownerEmail = config?.ownerEmail || configuration.ERP_ADMIN_EMAIL.toLowerCase();
    if (!(restored.users || []).some(user => !user.deletedAt && !user.archivedAt && user.status === 'Active' && String(user.email).toLowerCase() === ownerEmail && ['Admin', 'Super Admin'].includes(resolveRole(user.role, restored)))) throw new Error('The backup must contain an active administrator matching the configured administrator email.');
    const applicationTarget = options.applicationDirectory ? resolve(options.applicationDirectory) : undefined;
    if (applicationTarget) {
      if (!options.offline || manifest.application === 'none') throw new Error('Application files can only be recovered offline from an archive that includes the app.');
      const fromData = relative(dataDirectory, applicationTarget), fromApp = relative(applicationTarget, dataDirectory);
      if (!fromData || !fromData.startsWith('..') && !isAbsolute(fromData) || !fromApp || !fromApp.startsWith('..') && !isAbsolute(fromApp)) throw new Error('Application and data recovery directories must be separate.');
      if (await exists(applicationTarget)) throw new Error('Choose a new, nonexistent directory for recovered application files.');
    }
    let currentRevision = -1, safety: RecoveryBackup | undefined;
    if (await exists(join(dataDirectory, 'workspace.sqlite'))) {
      try {
        const database = new DatabaseSync(join(dataDirectory, 'workspace.sqlite'), { readOnly: true });
        try { currentRevision = Number(database.prepare('SELECT revision FROM erp_workspace WHERE id=?').get('main')?.revision ?? -1); } finally { database.close(); }
        if (options.expectedRevision !== undefined && currentRevision !== options.expectedRevision) throw new Error('CONFLICT: The workspace changed. Refresh before restoring.');
        if (!options.offline || dataDirectory === getHostingerConfig().dataDirectory) safety = await createRecoveryBackup(password, { safety: true });
      } catch (error) { if (!options.offline) throw error; keepStage = true; }
    }
    const revision = Math.max(currentRevision, manifest.revision) + 1, date = new Date().toISOString();
    restored.auditLogs ||= []; restored.activities ||= []; restored.backups ||= [];
    restored.auditLogs.push({ id: randomUUID(), name: 'Full recovery restored', actor: options.actor?.name || 'Offline recovery', actorId: options.actor?.id, action: 'restoreRecovery', module: 'backups', date, details: 'Database, uploaded files, users and password records restored. Sessions revoked.' });
    restored.activities.push({ id: randomUUID(), name: 'Full recovery restored', module: 'backups', action: 'restoreRecovery', date });
    restored.backups.push({ id: randomUUID(), name: 'Full recovery restore', type: 'Manual', date, status: 'Restored', destination: 'Private database and file storage', notes: safety ? `Safety backup: ${safety.id}` : 'Previous data retained in recovery staging directory.' });
    const targetVaultKey = config?.vaultKey || configuration.ERP_VAULT_KEY;
    // Historical cleanup snapshots must remain decryptable after restoring with a different vault key.
    for (const row of savedTables!.erp_workspace_migrations) {
      const snapshot: unknown = JSON.parse(String(row.data));
      validateStore(snapshot);
      row.data = JSON.stringify(await sealVault(await openVault(snapshot, configuration.ERP_VAULT_KEY), targetVaultKey));
    }
    const encrypted = await sealVault(restored, targetVaultKey), prepared = new DatabaseSync(join(directory, 'prepared.sqlite'));
    try {
      initializeDatabase(prepared);
      prepared.exec('BEGIN IMMEDIATE');
      prepared.prepare('INSERT INTO erp_workspace (id,data,revision,updated_at) VALUES (?,?,?,?)').run('main', JSON.stringify(encrypted), revision, date);
      // Rebuild known tables rather than installing untrusted SQLite triggers or schema.
      for (const [table, fields] of Object.entries(columns)) if (table !== 'erp_workspace') {
        const insert = prepared.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`);
        for (const row of savedTables![table]) insert.run(...fields.map(field => row[field]));
      }
      prepared.exec('COMMIT');
    } finally { prepared.close(); }
    if (applicationTarget) { await mkdir(resolve(applicationTarget, '..'), { recursive: true }); await rename(join(contents, 'application'), applicationTarget); }
    await writeFile(join(directory, 'recovery-config.json'), JSON.stringify({ ...configuration, ERP_DATA_DIR: dataDirectory }, null, 2), { mode: 0o600 });
    if (!options.offline) {
      if (activeFileWrites()) throw new Error('CONFLICT: A file upload is in progress. Retry restore when it finishes.');
      const latest = Number(runtimeDatabase().prepare('SELECT revision FROM erp_workspace WHERE id=?').get('main')?.revision);
      if (latest !== currentRevision) throw new Error('CONFLICT: The workspace changed during recovery. Refresh before restoring.');
    }
    const preservePrevious = keepStage || options.offline && !safety;
    keepStage = true; // Preserve the journal and rollback data if installation is interrupted.
    installRecoveredData(dataDirectory, stage, closeRuntimeDatabase, Boolean(options.offline));
    keepStage = Boolean(preservePrevious);
    return { success: true, revision, safetyBackup: safety?.id, application: manifest.application, applicationDirectory: applicationTarget, configurationFile: options.offline ? join(dataDirectory, 'recovery-config.json') : undefined, previousDataDirectory: keepStage ? join(directory, 'previous') : undefined };
  } finally {
    recovering = false;
    if (!keepStage) await rm(directory, { recursive: true, force: true });
  }
}
