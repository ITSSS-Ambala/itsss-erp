import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { runtimeDatabase, closeRuntimeDatabase } from '../lib/hostinger/database.ts';
import { hashPassword } from '../lib/hostinger/password.ts';
import { notificationReadDates, markNotificationsRead } from '../lib/hostinger/notification-reads.ts';
import { synchronizeNotifications, inboxNotifications, memberIdentity } from '../lib/notifications.ts';
import type { Store } from '../lib/schema.ts';

const originalEnvironment = { ...process.env };
let directory: string;
before(async () => {
  await mkdir(resolve('outputs'), { recursive: true });
  directory = await mkdtemp(resolve('outputs/notification-read-test-'));
  Object.assign(process.env, { NODE_ENV: 'production', ERP_PUBLIC_URL: 'http://127.0.0.1:5185', ERP_DATA_DIR: directory, ERP_VAULT_KEY: randomBytes(32).toString('base64'), ERP_ADMIN_EMAIL: 'owner@itsss.test', ERP_ADMIN_PASSWORD_HASH: await hashPassword('Synthetic notification test password'), ERP_AUTH_USERS: '[]' });
});
after(async () => {
  closeRuntimeDatabase();
  const cleanup = relative(resolve('outputs'), directory);
  assert.ok(cleanup && !cleanup.startsWith('..'));
  await rm(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
});

test('individual and bulk reads persist across restart, cannot affect other users, and never advance workspace revision', () => {
  const initial: Store = { users: [{ id: 'owner', name: 'Owner', role: 'Super Admin', status: 'Active' }, { id: 'manager', name: 'Manager', role: 'Manager', status: 'Active' }], tasks: [{ id: 'one', name: 'Work one', dueDate: '2026-10-10', status: 'Assigned' }, { id: 'two', name: 'Work two', dueDate: '2026-10-10', status: 'Assigned' }] };
  const store = synchronizeNotifications(initial, new Date('2026-10-10T06:00:00Z')).store;
  const owner = memberIdentity(store.users[0], store), manager = memberIdentity(store.users[1], store);
  const ownerRows = inboxNotifications(store, owner), managerRows = inboxNotifications(store, manager);
  runtimeDatabase().prepare('INSERT INTO erp_workspace (id, data, revision, updated_at) VALUES (?, ?, ?, ?)').run('main', JSON.stringify(store), 4, 'now');
  assert.equal(ownerRows.length, 2);
  assert.throws(() => markNotificationsRead(store, owner, [ownerRows[0].id, managerRows[0].id]), /own inbox/);
  assert.deepEqual(notificationReadDates(owner.memberId), {}, 'invalid bulk requests are atomic');
  markNotificationsRead(store, owner, [ownerRows[0].id], new Date('2026-10-10T07:00:00Z'));
  markNotificationsRead(store, owner, [ownerRows[0].id], new Date('2026-10-10T08:00:00Z'));
  assert.equal(notificationReadDates(owner.memberId)[ownerRows[0].id], '2026-10-10T07:00:00.000Z');
  assert.equal(Object.keys(notificationReadDates(manager.memberId)).length, 0);
  closeRuntimeDatabase();
  assert.equal(inboxNotifications(store, owner, notificationReadDates(owner.memberId)).filter(row => row.read).length, 1);
  markNotificationsRead(store, owner, undefined);
  assert.equal(inboxNotifications(store, owner, notificationReadDates(owner.memberId)).filter(row => row.read).length, 2);
  assert.equal(inboxNotifications(store, manager, notificationReadDates(manager.memberId)).filter(row => row.read).length, 0);
  assert.equal(runtimeDatabase().prepare('SELECT revision FROM erp_workspace WHERE id = ?').get('main')!.revision, 4);
  const revoked = structuredClone(store); revoked.tasks[0].deletedAt = 'now';
  assert.throws(() => markNotificationsRead(revoked, owner, [ownerRows.find(row => row.sourceId === 'one')!.id]), /own inbox/);
  assert.throws(() => markNotificationsRead(store, { ...owner, memberId: undefined }, []), /membership/);
});
