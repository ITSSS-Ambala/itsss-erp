import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRecoveryBackup, restoreRecoveryBackup, listRecoveryBackups, recoveryBackupFile } from '../lib/hostinger/recovery.ts';
import { extractRecoveryArchive, writeRecoveryArchive } from '../lib/hostinger/recovery-archive.ts';
import { runtimeDatabase, closeRuntimeDatabase } from '../lib/hostinger/database.ts';
import { recoverPendingRestore } from '../lib/hostinger/restore-install.ts';
import { privateBucket } from '../lib/hostinger/storage.ts';
import { hashPassword, verifyPassword } from '../lib/hostinger/password.ts';
import { openVault, sealVault } from '../lib/vault.ts';
import type { Store } from '../lib/schema.ts';

const originalEnvironment = { ...process.env }, password = 'Recovery password with spaces 123', managedPassword = 'A managed account password for restore';
let directory: string, appRoot: string, originalKey: string, backup: Awaited<ReturnType<typeof createRecoveryBackup>>;
const fileKey = 'files/1234-5678/project.txt', fileBytes = Buffer.from('Actual project attachment bytes');
before(async () => {
  await mkdir(resolve('outputs'), { recursive: true }); directory = await mkdtemp(resolve('outputs/recovery-test-')); appRoot = join(directory, 'app-source');
  await mkdir(join(appRoot, 'app'), { recursive: true }); await writeFile(join(appRoot, 'app', 'erp-app.tsx'), 'export default function App() { return null; }');
  await writeFile(join(appRoot, 'package.json'), '{"name":"recovery-fixture","version":"1.0.0"}');
  originalKey = randomBytes(32).toString('base64');
  Object.assign(process.env, { NODE_ENV: 'production', ERP_PUBLIC_URL: 'http://127.0.0.1:5186', ERP_DATA_DIR: directory, ERP_VAULT_KEY: originalKey, ERP_ADMIN_EMAIL: 'owner@itsss.test', ERP_ADMIN_PASSWORD_HASH: await hashPassword('Synthetic owner recovery password'), ERP_AUTH_USERS: '[]' });
  const store: Store = { users: [{ id: 'owner', name: 'Owner', email: 'owner@itsss.test', role: 'Super Admin', status: 'Active' }, { id: 'staff', name: 'Staff', email: 'staff@itsss.test', role: 'Sales', status: 'Active' }], roles: [], settings: [{ id: 'company', name: 'Original company' }], documents: [{ id: 'doc', name: 'Original project document', attachments: [{ key: fileKey }], status: 'Active' }], vault: [{ id: 'secret', name: 'Private credential', password: 'super-secret-vault-value' }], tasks: [], notifications: [], auditLogs: [], activities: [], backups: [] };
  await privateBucket.put(fileKey, new Blob([fileBytes]).stream(), { customMetadata: { name: 'project.txt', creatorId: 'owner', module: 'documents', recordId: 'doc' }, httpMetadata: { contentType: 'text/plain' } });
  runtimeDatabase().prepare('INSERT INTO erp_workspace (id,data,revision,updated_at) VALUES (?,?,?,?)').run('main', JSON.stringify(await sealVault(store, originalKey)), 5, 'now');
  runtimeDatabase().prepare('INSERT INTO auth_passwords (member_id,password_hash) VALUES (?,?)').run('staff', await hashPassword(managedPassword));
  runtimeDatabase().prepare('INSERT INTO notification_reads VALUES (?,?,?)').run('staff', 'read-notification', 'read-date');
  runtimeDatabase().prepare('INSERT INTO notification_clears VALUES (?,?,?)').run('staff', 'cleared-notification', 'clear-date');
  runtimeDatabase().prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('synthetic-session', 'staff@itsss.test', 'credential', 9999999999999);
  backup = await createRecoveryBackup(password, { applicationRoot: appRoot });
});
after(async () => {
  closeRuntimeDatabase(); assert.ok(relative(resolve('outputs'), directory) && !relative(resolve('outputs'), directory).startsWith('..'));
  await rm(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]; Object.assign(process.env, originalEnvironment);
});

test('password protected archives include consistent SQLite, uploaded bytes, credentials, inbox state and app source', async () => {
  assert.equal(backup.application, 'source'); assert.equal(backup.revision, 5);
  const file = await recoveryBackupFile(backup.id), bytes = await readFile(file.filename);
  for (const secret of ['super-secret-vault-value', originalKey, process.env.ERP_ADMIN_PASSWORD_HASH!]) assert.ok(!bytes.includes(Buffer.from(secret)));
  const extracted = join(directory, 'inspect'), paths = await extractRecoveryArchive(file.filename, extracted, password);
  assert.ok(paths.includes('application/app/erp-app.tsx')); assert.ok(paths.some(path => path.endsWith('.bin')));
  const database = new DatabaseSync(join(extracted, 'contents', 'workspace.sqlite'), { readOnly: true });
  try { assert.equal(database.prepare('PRAGMA quick_check').get()?.quick_check, 'ok'); assert.ok(await verifyPassword(managedPassword, String(database.prepare('SELECT password_hash FROM auth_passwords WHERE member_id=?').get('staff')?.password_hash))); }
  finally { database.close(); }
  assert.equal((await listRecoveryBackups()).length, 1);
  await assert.rejects(recoveryBackupFile('../workspace.sqlite'), /Choose a saved/);
});

test('wrong passwords, tampering, traversal and stale revisions cannot change current data', async () => {
  const file = (await recoveryBackupFile(backup.id)).filename;
  await assert.rejects(restoreRecoveryBackup(file, 'Wrong archive password 12345', { expectedRevision: 5 }), /password is incorrect/);
  const tampered = join(directory, 'tampered.itsss-backup'), bytes = await readFile(file); bytes[bytes.length - 20] ^= 1; await writeFile(tampered, bytes);
  await assert.rejects(restoreRecoveryBackup(tampered, password, { expectedRevision: 5 }), /password is incorrect|damaged/);
  await assert.rejects(restoreRecoveryBackup(file, password, { expectedRevision: 4 }), /CONFLICT/);
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }), cipher = createCipheriv('aes-256-gcm', key, iv);
  const metadata = Buffer.from(JSON.stringify({ path: '../escape.txt', size: 0 })), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(Buffer.concat([length, metadata]))), cipher.final()]);
  const malicious = join(directory, 'malicious.itsss-backup'); await writeFile(malicious, Buffer.concat([Buffer.from('ITSSS-RECOVERY-1\n'), salt, iv, ciphertext, cipher.getAuthTag()]));
  await assert.rejects(extractRecoveryArchive(malicious, join(directory, 'malicious-extract'), password), /Invalid path/);
  assert.equal(runtimeDatabase().prepare('SELECT revision FROM erp_workspace WHERE id=?').get('main')?.revision, 5);
});

test('full online restore restores users, managed passwords and files, reencrypts vault and saves a safety backup', async () => {
  const currentKey = randomBytes(32).toString('base64'), row = runtimeDatabase().prepare('SELECT data FROM erp_workspace WHERE id=?').get('main')!;
  const current = await openVault(JSON.parse(String(row.data)), originalKey); current.settings[0].name = 'Later company'; current.documents = []; process.env.ERP_VAULT_KEY = currentKey;
  runtimeDatabase().prepare('UPDATE erp_workspace SET data=?,revision=7 WHERE id=?').run(JSON.stringify(await sealVault(current, currentKey)), 'main');
  await rm(join(directory, 'files'), { recursive: true, force: true });
  runtimeDatabase().prepare('DELETE FROM auth_passwords').run();
  const result = await restoreRecoveryBackup((await recoveryBackupFile(backup.id)).filename, password, { expectedRevision: 7, actor: { id: 'owner', name: 'Owner' } });
  assert.ok(result.safetyBackup); assert.equal(result.revision, 8);
  closeRuntimeDatabase();
  const restored = await openVault(JSON.parse(String(runtimeDatabase().prepare('SELECT data FROM erp_workspace WHERE id=?').get('main')?.data)), currentKey);
  assert.equal(restored.settings[0].name, 'Original company'); assert.equal(restored.vault[0].password, 'super-secret-vault-value');
  assert.ok(await verifyPassword(managedPassword, String(runtimeDatabase().prepare('SELECT password_hash FROM auth_passwords WHERE member_id=?').get('staff')?.password_hash)));
  assert.deepEqual(Buffer.from(await (await privateBucket.get(fileKey))!.arrayBuffer()), fileBytes);
  assert.equal(runtimeDatabase().prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()?.count, 0);
  assert.equal(runtimeDatabase().prepare('SELECT cleared_at FROM notification_clears WHERE member_id=?').get('staff')?.cleared_at, 'clear-date');
  assert.equal(runtimeDatabase().prepare('SELECT read_at FROM notification_reads WHERE member_id=?').get('staff')?.read_at, 'read-date');
  assert.ok(restored.auditLogs.some(row => row.action === 'restoreRecovery'));
  assert.equal((await listRecoveryBackups()).length, 2);
});

test('unexpected SQLite triggers and missing files are rejected before replacement', async () => {
  const extraction = join(directory, 'modified'), paths = await extractRecoveryArchive((await recoveryBackupFile(backup.id)).filename, extraction, password), contents = join(extraction, 'contents');
  const database = new DatabaseSync(join(contents, 'workspace.sqlite'));
  database.exec('CREATE TRIGGER evil AFTER INSERT ON auth_passwords BEGIN DELETE FROM erp_workspace; END;'); database.close();
  const modified = join(directory, 'trigger.itsss-backup');
  await writeRecoveryArchive(modified, await Promise.all(paths.map(async path => ({ path, filename: join(contents, path), size: (await stat(join(contents, path))).size }))), password);
  await assert.rejects(restoreRecoveryBackup(modified, password, { expectedRevision: 8 }), /Unexpected schema/);
  const second = join(directory, 'missing'), secondPaths = await extractRecoveryArchive((await recoveryBackupFile(backup.id)).filename, second, password), removed = secondPaths.filter(path => !path.startsWith('files/'));
  const manifestPath = join(second, 'contents', 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.entries = removed.length; await writeFile(manifestPath, JSON.stringify(manifest));
  const missing = join(directory, 'missing.itsss-backup'); await writeRecoveryArchive(missing, await Promise.all(removed.map(async path => ({ path, filename: join(second, 'contents', path), size: (await stat(join(second, 'contents', path))).size }))), password);
  await assert.rejects(restoreRecoveryBackup(missing, password, { expectedRevision: 8 }), /missing an uploaded file/);
  assert.equal(runtimeDatabase().prepare('SELECT revision FROM erp_workspace WHERE id=?').get('main')?.revision, 8);
});

test('offline recovery restores app files and private configuration without a running or configured app', async () => {
  const target = join(directory, 'recovered-data'), targetApp = join(directory, 'recovered-app');
  const savedData = process.env.ERP_DATA_DIR, savedHash = process.env.ERP_ADMIN_PASSWORD_HASH, savedKey = process.env.ERP_VAULT_KEY; delete process.env.ERP_ADMIN_PASSWORD_HASH; delete process.env.ERP_VAULT_KEY; delete process.env.ERP_DATA_DIR;
  try {
    const result = await restoreRecoveryBackup(join(directory, 'backups', backup.id), password, { offline: true, dataDirectory: target, applicationDirectory: targetApp });
    assert.equal(await readFile(join(targetApp, 'app', 'erp-app.tsx'), 'utf8'), 'export default function App() { return null; }');
    const configuration = JSON.parse(await readFile(result.configurationFile!, 'utf8')); assert.equal(configuration.ERP_VAULT_KEY, originalKey); assert.equal(configuration.ERP_DATA_DIR, target);
    const database = new DatabaseSync(join(target, 'workspace.sqlite'), { readOnly: true }); try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM auth_passwords').get()?.count, 1); } finally { database.close(); }
    assert.ok((await readdir(join(target, 'files'))).length);
  } finally { process.env.ERP_DATA_DIR = savedData; process.env.ERP_ADMIN_PASSWORD_HASH = savedHash; process.env.ERP_VAULT_KEY = savedKey; }
});

test('offline recovery replaces a crashed database and retains its previous bytes for inspection', async () => {
  const target = join(directory, 'crashed-data'); await mkdir(join(target, 'files'), { recursive: true });
  await writeFile(join(target, 'workspace.sqlite'), 'damaged database bytes'); await writeFile(join(target, 'files', 'old.txt'), 'old file');
  const result = await restoreRecoveryBackup(join(directory, 'backups', backup.id), password, { offline: true, dataDirectory: target });
  assert.ok(result.previousDataDirectory);
  assert.equal(await readFile(join(result.previousDataDirectory!, 'workspace.sqlite'), 'utf8'), 'damaged database bytes');
  assert.equal(await readFile(join(result.previousDataDirectory!, 'files', 'old.txt'), 'utf8'), 'old file');
  const database = new DatabaseSync(join(target, 'workspace.sqlite'), { readOnly: true }); try { assert.equal(database.prepare('PRAGMA quick_check').get()?.quick_check, 'ok'); } finally { database.close(); }
});

test('an interrupted filesystem swap is rolled back from its journal', async () => {
  const target = join(directory, 'interrupted'), stage = '.restore-12345678-1234-1234-1234-123456789012';
  await mkdir(join(target, 'backups', stage, 'previous', 'files'), { recursive: true }); await mkdir(join(target, 'files'), { recursive: true });
  await writeFile(join(target, 'backups', stage, 'previous', 'workspace.sqlite'), 'old database'); await writeFile(join(target, 'backups', stage, 'previous', 'files', 'original.txt'), 'old file');
  await writeFile(join(target, 'workspace.sqlite'), 'new database'); await writeFile(join(target, 'files', 'replacement.txt'), 'new file');
  await writeFile(join(target, '.restore-journal.json'), JSON.stringify({ stage, original: ['workspace.sqlite', 'files'], committed: false }));
  recoverPendingRestore(target);
  assert.equal(await readFile(join(target, 'workspace.sqlite'), 'utf8'), 'old database'); assert.deepEqual(await readdir(join(target, 'files')), ['original.txt']);
});
