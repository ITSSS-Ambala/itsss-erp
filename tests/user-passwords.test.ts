import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { runtimeDatabase, closeRuntimeDatabase } from '../lib/hostinger/database.ts';
import { hashPassword, verifyPassword } from '../lib/hostinger/password.ts';
import { login, sessionIdentity } from '../lib/hostinger/sessions.ts';
import { managePassword } from '../lib/hostinger/manage-password.ts';
import type { Store } from '../lib/schema.ts';

const originalEnvironment = { ...process.env };
const initialPassword = 'Initial owner test password';
const staffPassword = 'Synthetic staff test password';
const changedPassword = 'Replacement test password';
const owner = { userId: 'owner-identity', memberId: 'owner', displayName: 'Owner', email: 'owner@itsss.test', role: 'Super Admin' };
const viewer = { userId: 'viewer-identity', memberId: 'staff', displayName: 'Viewer', email: 'staff@itsss.test', role: 'Viewer' };
let directory: string;
let initialHash: string;
function workspace() {
  const row = runtimeDatabase().prepare('SELECT data, revision FROM erp_workspace WHERE id = ?').get('main')!;
  return { store: JSON.parse(String(row.data)) as Store, revision: Number(row.revision) };
}
function reset(memberId = 'staff', password = staffPassword) {
  const { store, revision } = workspace();
  return managePassword(store, revision, owner, { mode: 'reset', memberId, password });
}

before(async () => {
  await mkdir(resolve('outputs'), { recursive: true });
  directory = await mkdtemp(resolve('outputs/password-test-'));
  initialHash = await hashPassword(initialPassword);
  Object.assign(process.env, { NODE_ENV: 'production', ERP_PUBLIC_URL: 'http://127.0.0.1:5183', ERP_DATA_DIR: directory, ERP_VAULT_KEY: randomBytes(32).toString('base64'), ERP_ADMIN_EMAIL: owner.email, ERP_ADMIN_PASSWORD_HASH: initialHash, ERP_AUTH_USERS: '[]' });
});
beforeEach(() => {
  process.env.ERP_ADMIN_PASSWORD_HASH = initialHash;
  const store: Store = { users: [{ id: 'owner', identityId: owner.userId, name: 'Owner', email: owner.email, role: 'admin-role', status: 'Active' }, { id: 'staff', name: 'Viewer', email: viewer.email, role: 'viewer-role', status: 'Active' }], roles: [{ id: 'admin-role', name: 'Super Admin', status: 'Active' }, { id: 'viewer-role', name: 'Viewer', status: 'Active' }], settings: [{ id: 'company', passwordMinLength: 12 }], auditLogs: [], vault: [] };
  const database = runtimeDatabase();
  database.exec('DELETE FROM auth_passwords; DELETE FROM auth_sessions; DELETE FROM auth_attempts; DELETE FROM erp_workspace;');
  database.prepare('INSERT INTO erp_workspace (id, data, revision, updated_at) VALUES (?, ?, 0, ?)').run('main', JSON.stringify(store), 'now');
});
after(async () => {
  closeRuntimeDatabase();
  const cleanup = relative(resolve('outputs'), directory);
  assert.ok(cleanup && !cleanup.startsWith('..'));
  await rm(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

test('administrators provision login passwords without environment changes; hashes and login survive restart', async () => {
  assert.equal(await login(viewer.email, staffPassword), null);
  const result = await reset();
  assert.equal(result.signInAgain, false);
  const signedIn = await login(viewer.email.toUpperCase(), staffPassword);
  assert.ok(signedIn);
  assert.equal(sessionIdentity(signedIn.token)?.displayName, 'Viewer');
  const hash = String(runtimeDatabase().prepare('SELECT password_hash FROM auth_passwords WHERE member_id = ?').get('staff')!.password_hash);
  assert.notEqual(hash, staffPassword);
  assert.ok(await verifyPassword(staffPassword, hash));
  const serialized = JSON.stringify(workspace().store);
  assert.ok(!serialized.includes(staffPassword));
  assert.ok(!serialized.includes(hash));
  assert.equal(workspace().store.auditLogs[0].action, 'resetPassword');
  closeRuntimeDatabase();
  assert.ok(sessionIdentity(signedIn.token));
  assert.ok(await login(viewer.email, staffPassword));
});

test('reset revokes existing sessions and replaces the old password without changing roles', async () => {
  await reset();
  const signedIn = (await login(viewer.email, staffPassword))!;
  await reset('staff', changedPassword);
  assert.equal(sessionIdentity(signedIn.token), null);
  assert.equal(await login(viewer.email, staffPassword), null);
  assert.ok(await login(viewer.email, changedPassword));
  assert.equal(workspace().store.users[1].role, 'viewer-role');
});

test('users change their own password only after verifying the current password', async () => {
  await reset();
  const signedIn = (await login(viewer.email, staffPassword))!;
  let current = workspace();
  await assert.rejects(managePassword(current.store, current.revision, viewer, { mode: 'change', memberId: 'staff', password: changedPassword, currentPassword: 'incorrect password' }), /Current password is incorrect/);
  assert.ok(sessionIdentity(signedIn.token));
  current = workspace();
  const result = await managePassword(current.store, current.revision, viewer, { mode: 'change', memberId: 'staff', password: changedPassword, currentPassword: staffPassword });
  assert.equal(result.signInAgain, true);
  assert.equal(sessionIdentity(signedIn.token), null);
  assert.ok(await login(viewer.email, changedPassword));
});

test('nonadministrators cannot reset passwords or change another account', async () => {
  const { store, revision } = workspace();
  await assert.rejects(managePassword(store, revision, viewer, { mode: 'reset', memberId: 'owner', password: changedPassword }), /FORBIDDEN/);
  await assert.rejects(managePassword(store, revision, viewer, { mode: 'change', memberId: 'owner', password: changedPassword, currentPassword: initialPassword }), /FORBIDDEN/);
  assert.equal(runtimeDatabase().prepare('SELECT COUNT(*) AS total FROM auth_passwords').get()!.total, 0);
});

test('password policy and inactive or deleted memberships fail before writing credentials', async () => {
  const { store, revision } = workspace();
  store.settings[0].passwordMinLength = 20;
  await assert.rejects(managePassword(store, revision, owner, { mode: 'reset', memberId: 'staff', password: 'too short' }), /at least 20/);
  await assert.rejects(managePassword(store, revision, owner, { mode: 'reset', memberId: 'staff', password: '\u00e9'.repeat(129) }), /256 bytes/);
  for (const state of [{ status: 'Inactive' }, { status: 'Locked' }, { deletedAt: 'today' }, { archivedAt: 'today' }, { role: 'missing' }]) {
    const next = structuredClone(store);
    Object.assign(next.users[1], state);
    await assert.rejects(managePassword(next, revision, owner, { mode: 'reset', memberId: 'staff', password: staffPassword }), /active user/);
  }
  assert.equal(runtimeDatabase().prepare('SELECT COUNT(*) AS total FROM auth_passwords').get()!.total, 0);
});

test('stale password updates roll back credentials, audit changes and session revocation', async () => {
  await reset();
  const stale = workspace();
  await reset('staff', changedPassword);
  const signedIn = (await login(viewer.email, changedPassword))!;
  await assert.rejects(managePassword(stale.store, stale.revision, owner, { mode: 'reset', memberId: 'staff', password: staffPassword }), /CONFLICT/);
  assert.ok(sessionIdentity(signedIn.token));
  assert.ok(await login(viewer.email, changedPassword));
  assert.equal(workspace().store.auditLogs.length, 2);
});

test('disabled memberships invalidate managed sessions and cannot authenticate', async () => {
  await reset();
  const signedIn = (await login(viewer.email, staffPassword))!;
  const { store } = workspace();
  store.users[1].status = 'Locked';
  runtimeDatabase().prepare('UPDATE erp_workspace SET data = ? WHERE id = ?').run(JSON.stringify(store), 'main');
  assert.equal(sessionIdentity(signedIn.token), null);
  assert.equal(await login(viewer.email, staffPassword), null);
});

test('environment hash rotation recovers an administrator after a managed password change', async () => {
  await reset('owner', changedPassword);
  const signedIn = (await login(owner.email, changedPassword))!;
  assert.equal(signedIn.user.userId, owner.userId);
  assert.equal(await login(owner.email, initialPassword), null);
  process.env.ERP_ADMIN_PASSWORD_HASH = await hashPassword(initialPassword);
  assert.equal(sessionIdentity(signedIn.token), null);
  assert.ok(await login(owner.email, initialPassword));
});

test('current-password throttling persists across database restart', async () => {
  await reset();
  const { store, revision } = workspace();
  for (let attempt = 0; attempt < 10; attempt++) await assert.rejects(managePassword(store, revision, viewer, { mode: 'change', memberId: 'staff', password: changedPassword, currentPassword: 'incorrect' }), /Current password is incorrect/);
  closeRuntimeDatabase();
  await assert.rejects(managePassword(store, revision, viewer, { mode: 'change', memberId: 'staff', password: changedPassword, currentPassword: staffPassword }), /RATE_LIMIT/);
  assert.ok(await login(viewer.email, staffPassword));
});
