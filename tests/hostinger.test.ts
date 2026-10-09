import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, validPasswordHash } from '../lib/hostinger/password.ts';
import { getHostingerConfig } from '../lib/hostinger/config.ts';
import { closeRuntimeDatabase, runtimeDatabase, workspaceDatabase } from '../lib/hostinger/database.ts';
import { login, sessionIdentity, revokeSession, safeReturnPath, sessionCookieName } from '../lib/hostinger/sessions.ts';
import { privateBucket } from '../lib/hostinger/storage.ts';

let directory: string;
const password = 'A synthetic password for runtime checks';
let passwordHash: string;
const savedEnvironment = { ...process.env };
before(async () => {
  await mkdir(resolve('outputs'), { recursive: true });
  directory = await mkdtemp(resolve('outputs/hostinger-test-'));
  passwordHash = await hashPassword(password);
  Object.assign(process.env, { NODE_ENV: 'production', ERP_PUBLIC_URL: 'http://127.0.0.1:5182', ERP_DATA_DIR: directory, ERP_VAULT_KEY: randomBytes(32).toString('base64'), ERP_ADMIN_EMAIL: 'owner@itsss.test', ERP_ADMIN_PASSWORD_HASH: passwordHash, ERP_AUTH_USERS: '[]', ERP_SESSION_HOURS: '12' });
});
after(async () => {
  closeRuntimeDatabase();
  const cleanupPath = relative(resolve('outputs'), directory);
  assert.ok(cleanupPath && !cleanupPath.startsWith('..'), 'Test cleanup must stay inside outputs');
  await rm(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

test('password hashes are salted, bounded and reject wrong or malformed credentials', async () => {
  assert.ok(validPasswordHash(passwordHash));
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('wrong password', passwordHash), false);
  assert.notEqual(await hashPassword(password), passwordHash);
  assert.equal(await verifyPassword(password, 'scrypt$invalid'), false);
  await assert.rejects(hashPassword('short'));
});
test('configuration rejects public or deployment storage paths and public HTTP', () => {
  const previous = process.env.ERP_DATA_DIR!;
  process.env.ERP_DATA_DIR = join(directory, 'public_html', 'data');
  assert.throws(getHostingerConfig, /outside public_html/);
  process.env.ERP_DATA_DIR = join(directory, 'hbuilds', 'data');
  assert.throws(getHostingerConfig, /outside public_html/);
  process.env.ERP_DATA_DIR = previous;
  process.env.ERP_PUBLIC_URL = 'http://crm.itsss.co.in';
  assert.throws(getHostingerConfig, /must use HTTPS/);
  process.env.ERP_PUBLIC_URL = 'http://127.0.0.1:5182';
});
test('workspace revision updates persist and only one stale writer can succeed', async () => {
  await workspaceDatabase.prepare('INSERT OR IGNORE INTO erp_workspace (id,data,revision,updated_at) VALUES (?,?,0,?)').bind('test', '{"name":"original"}', 'now').run();
  const update = () => workspaceDatabase.prepare('UPDATE erp_workspace SET data=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?').bind('{"name":"changed"}', 'later', 'test', 0).run();
  const results = await Promise.all([update(), update()]);
  assert.deepEqual(results.map(result => result.meta.changes).sort(), [0, 1]);
  closeRuntimeDatabase();
  assert.equal((await workspaceDatabase.prepare('SELECT data, revision FROM erp_workspace WHERE id = ?').bind('test').first<{ revision: number }>())?.revision, 1);
});
test('opaque sessions persist across restarts and revoke on sign-out, expiry and password rotation', async () => {
  const result = await login('OWNER@itsss.test', password);
  assert.ok(result);
  assert.equal(sessionIdentity(result.token)?.email, 'owner@itsss.test');
  const row = runtimeDatabase().prepare('SELECT token_hash FROM auth_sessions').get()!;
  assert.notEqual(row.token_hash, result.token);
  assert.equal(sessionIdentity(randomBytes(32).toString('base64url')), null);
  closeRuntimeDatabase();
  assert.ok(sessionIdentity(result.token));
  process.env.ERP_ADMIN_PASSWORD_HASH = await hashPassword(password);
  assert.equal(sessionIdentity(result.token), null);
  process.env.ERP_ADMIN_PASSWORD_HASH = passwordHash;
  revokeSession(result.token);
  assert.equal(sessionIdentity(result.token), null);
  const expiring = (await login('owner@itsss.test', password))!;
  runtimeDatabase().prepare('UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?').run(createHash('sha256').update(expiring.token).digest('hex'));
  assert.equal(sessionIdentity(expiring.token), null);
});
test('sign-in throttling survives process restarts and cannot be skipped with another token', async () => {
  runtimeDatabase().prepare('DELETE FROM auth_attempts').run();
  for (let i = 0; i < 10; i++) assert.equal(await login('owner@itsss.test', 'incorrect'), null);
  closeRuntimeDatabase();
  await assert.rejects(login('owner@itsss.test', password), /RATE_LIMIT/);
  runtimeDatabase().prepare('DELETE FROM auth_attempts').run();
});
test('only configured accounts authenticate; duplicate accounts and bad hashes reject', async () => {
  assert.equal(await login('not-configured@itsss.test', password), null);
  process.env.ERP_AUTH_USERS = JSON.stringify([{ email: 'owner@itsss.test', passwordHash }]);
  assert.throws(getHostingerConfig, /duplicate email/);
  process.env.ERP_AUTH_USERS = '[]';
});
test('private objects preserve metadata and ranges, survive restart and reject traversal', async () => {
  const bytes = new TextEncoder().encode('private attachment contents');
  const key = 'files/1234-5678/test.txt';
  await privateBucket.put(key, new Blob([bytes]).stream(), { httpMetadata: { contentType: 'text/plain' }, customMetadata: { name: 'test.txt', creatorId: 'owner' } });
  assert.equal((await privateBucket.head(key))?.size, bytes.length);
  assert.equal((await privateBucket.head(key))?.customMetadata.creatorId, 'owner');
  const full = (await privateBucket.get(key))!;
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  const partial = (await privateBucket.get(key, { range: { offset: 2, length: 6 } }))!;
  assert.deepEqual(new Uint8Array(await new Response(partial.body).arrayBuffer()), bytes.slice(2, 8));
  await assert.rejects(privateBucket.get(key, { range: { offset: -1, length: 6 } }));
  await assert.rejects(privateBucket.head('files/../secret'));
  await assert.rejects(privateBucket.head('files/valid/..'));
  assert.equal(await privateBucket.head('files/missing/test.txt'), null);
  await assert.rejects(privateBucket.put(key, new Blob([bytes]).stream()), /already exists/);
});
test('redirects stay within the application and production cookies use the Host prefix', () => {
  assert.equal(safeReturnPath('//evil.test'), '/');
  assert.equal(safeReturnPath('/\\evil.test'), '/');
  assert.equal(safeReturnPath('/login'), '/');
  assert.equal(safeReturnPath('/#projects'), '/#projects');
  const previousDirectory = process.env.ERP_DATA_DIR;
  process.env.ERP_PUBLIC_URL = 'https://crm.itsss.co.in';
  // A sibling of the project is a private external directory; validation only.
  process.env.ERP_DATA_DIR = resolve('../hostinger-private-validation');
  assert.equal(sessionCookieName(), '__Host-itsss_session');
  process.env.ERP_PUBLIC_URL = 'http://127.0.0.1:5182';
  process.env.ERP_DATA_DIR = previousDirectory;
});
