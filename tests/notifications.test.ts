import test from 'node:test';
import assert from 'node:assert/strict';
import { getAlerts, getReceivables, runAutomations } from '../lib/engine.ts';
import { applyMutation } from '../lib/engine.ts';
import { createSeed } from '../lib/seed.ts';
import { modules, type Store } from '../lib/schema.ts';
import { canViewRecord, visibleStore } from '../lib/access.ts';
import { synchronizeNotifications, inboxNotifications, memberIdentity } from '../lib/notifications.ts';
import { businessDate, daysFromToday, dueInstant } from '../lib/business-time.ts';

const now = new Date('2026-10-10T06:00:00Z'); // 11:30 in Ambala
function fixture(): Store {
  const store: Store = Object.fromEntries(modules.map(module => [module.id, []]));
  store.users = [
    { id: 'owner', name: 'Owner', role: 'Super Admin', status: 'Active' },
    { id: 'manager', name: 'Manager', role: 'Manager', status: 'Active' },
    { id: 'sales', name: 'Sales', role: 'Sales', employee: 'sales-employee', status: 'Active' },
    { id: 'accounts', name: 'Accounts', role: 'Accounts', status: 'Active' },
    { id: 'inventory', name: 'Inventory', role: 'Inventory', status: 'Active' },
    { id: 'tech-a', name: 'Technician A', role: 'Technician', employee: 'employee-a', status: 'Active' },
    { id: 'tech-b', name: 'Technician B', role: 'Technician', employee: 'employee-b', status: 'Active' },
    { id: 'client-a', name: 'Customer A', role: 'Client', customer: 'customer-a', status: 'Active' },
    { id: 'client-b', name: 'Customer B', role: 'Client', customer: 'customer-b', status: 'Active' },
    { id: 'inactive', name: 'Inactive account', role: 'Admin', status: 'Inactive' },
  ];
  store.employees = ['employee-a', 'employee-b', 'sales-employee'].map(id => ({ id, name: id, status: 'Active' }));
  store.customers = ['customer-a', 'customer-b'].map(id => ({ id, name: id, status: 'Active' }));
  store.projects = [{ id: 'project-a', name: 'Real project', customer: 'customer-a', value: 10000, estimatedCost: 2000, status: 'In Progress', technicians: ['employee-a'], salesperson: 'sales-employee', dueDate: '2026-10-15', paymentDueDate: '2026-10-09' }];
  store.payments = [{ id: 'receipt', name: 'Customer receipt', project: 'project-a', customer: 'customer-a', amount: 7500, status: 'Received' }];
  return store;
}
function inbox(store: Store, id: string) { return inboxNotifications(store, memberIdentity(store.users.find(row => row.id === id)!, store)); }
function deliveredTo(store: Store, type: string) { return store.notifications.filter(row => row.type === type && row.status !== 'Resolved').map(row => row.recipientUserId).sort(); }

test('payment alerts use complete accounting and exclude fully paid, cancelled, archived and invalid-date projects', () => {
  const store = fixture();
  store.payments.push({ id: 'pending', project: 'project-a', amount: 2000, status: 'Pending' });
  let result = synchronizeNotifications(store, now);
  assert.match(inbox(result.store, 'accounts').find(row => row.type === 'Payment Overdue')!.message, /2,500 outstanding/);
  assert.deepEqual(deliveredTo(result.store, 'Payment Overdue'), ['accounts', 'client-a', 'manager', 'owner']);
  for (const id of ['sales', 'tech-a', 'tech-b', 'client-b', 'inactive']) assert.equal(inbox(result.store, id).length, 0);
  result.store.payments.push({ id: 'settlement', project: 'project-a', amount: 2500, status: 'Received' });
  result = synchronizeNotifications(result.store, now);
  assert.equal(deliveredTo(result.store, 'Payment Overdue').length, 0);
  for (const change of [{ status: 'Cancelled' }, { archivedAt: now.toISOString() }, { paymentDueDate: '' }, { paymentDueDate: '2026-02-30' }]) {
    const copy = fixture(); Object.assign(copy.projects[0], change);
    assert.equal(getAlerts(copy, now).filter(row => row.type.startsWith('Payment ')).length, 0);
  }
});

test('refunds reopen the genuine outstanding balance and independent receivables are included once', () => {
  const store = fixture();
  store.payments[0].amount = 10000;
  store.payments.push({ id: 'refund', project: 'project-a', amount: 1000, type: 'Refund', status: 'Received', archivedAt: now.toISOString() });
  store.receivables = [{ id: 'other', name: 'Other customer balance', customer: 'customer-a', amount: 500, paid: 100, dueDate: '2026-10-10' }, { id: 'linked', project: 'project-a', amount: 10000, paid: 0, dueDate: '2026-10-09' }];
  const alerts = getAlerts(store, now).filter(row => row.type.startsWith('Payment '));
  assert.equal(alerts.length, 2);
  assert.match(alerts.find(row => row.recordId === 'project-a')!.message, /1,000 outstanding/);
  assert.match(alerts.find(row => row.recordId === 'other')!.message, /400 outstanding/);
});

test('date-only and local datetime reminders follow India time and do not fire before the scheduled time', () => {
  assert.equal(businessDate(new Date('2026-10-09T20:00:00Z')), '2026-10-10');
  assert.equal(daysFromToday('2026-10-10', new Date('2026-10-09T20:00:00Z')), 0);
  assert.equal(dueInstant('2026-10-10T12:00'), Date.parse('2026-10-10T06:30:00Z'));
  assert.equal(daysFromToday('2026-10-09T20:00:00Z', now), 0);
  for (const value of ['', 'invalid', '2026-02-30', '2026-10-10T24:00', '2026-10-10T12:60', '2026-10-10Tgarbage']) { assert.equal(dueInstant(value), undefined); assert.equal(daysFromToday(value, now), undefined); }
  const store = fixture();
  store.followups = [
    { id: 'due', dueAt: '2026-10-10T11:00', assignedTo: 'sales-employee', status: 'Scheduled' },
    { id: 'future', dueAt: '2026-10-10T12:00', status: 'Scheduled' },
    { id: 'missing', status: 'Scheduled' },
    { id: 'bad', dueAt: 'invalid', status: 'Scheduled' },
    { id: 'closed', dueAt: '2026-10-09T11:00', status: 'Completed' },
  ];
  assert.deepEqual(getAlerts(store, now).filter(row => row.type === 'Follow-up Due').map(row => row.recordId), ['due']);
  const synced = synchronizeNotifications(store, now);
  assert.deepEqual(deliveredTo(synced.store, 'Follow-up Due'), ['manager', 'owner', 'sales']);
  assert.equal(synchronizeNotifications(synced.store, now).changed, 0, 'unnamed records also deduplicate');
});

test('no demo or unverified legacy notification enters any personal inbox', () => {
  const seed = createSeed();
  seed.users = fixture().users;
  const result = synchronizeNotifications(runAutomations(seed, now).store, now, seed);
  assert.equal(result.store.notifications.length, 0);
  const store = fixture();
  store.notifications = [{ id: 'fake', name: 'Legacy sample', sourceModule: 'projects', sourceId: 'project-a', type: 'Payment Overdue', channel: 'In-App', status: 'Delivered', recipientUserId: 'owner' }];
  assert.equal(inbox(store, 'owner').length, 0);
});

test('automatic completion follow-ups retain a full three days and accounting agrees at India midnight', () => {
  const store = fixture(), earliest = Date.now() + 3 * 86400000 - 60000;
  const completed = applyMutation(store, 'projects', 'update', { status: 'Completed' }, 'project-a').store;
  const due = dueInstant(completed.followups[0].dueAt)!;
  assert.ok(due >= earliest && due <= Date.now() + 3 * 86400000);
  const balance = getReceivables(store, new Date('2026-10-09T20:00:00Z'))[0];
  assert.equal(balance.daysOverdue, 1);
  assert.equal(balance.status, 'Overdue');
});

test('stock alerts require a configured valid minimum and reach authorized inventory staff', () => {
  const store = fixture();
  store.products = [{ id: 'camera', name: 'IP camera', minimumStock: 2, status: 'Active' }];
  store.inventory = [{ id: 'stock', name: 'Warehouse cameras', product: 'camera', location: 'Warehouse', quantity: 10, reserved: 7, damaged: 1 }];
  const synced = synchronizeNotifications(store, now);
  assert.deepEqual(deliveredTo(synced.store, 'Low Stock'), ['inventory', 'manager', 'owner']);
  assert.match(inbox(synced.store, 'inventory')[0].message, /2 available/);
  store.products[0].minimumStock = 0.3;
  Object.assign(store.inventory[0], { quantity: 0.4, reserved: 0.1, damaged: 0 });
  assert.match(getAlerts(store, now).find(row => row.type === 'Low Stock')!.message, /0\.3 available/, 'fractional stock uses the same rounded availability as the inventory ledger');
  for (const value of [undefined, '', 'bad', -1]) { store.products[0].minimumStock = value; assert.equal(getAlerts(store, now).filter(row => row.type === 'Low Stock').length, 0); }
  store.products[0].minimumStock = 2;
  store.inventory[0].archivedAt = now.toISOString();
  assert.equal(getAlerts(store, now).filter(row => row.type === 'Low Stock').length, 0);
});

test('work assignments reach each responsible technician and never unrelated technicians or customers', () => {
  const before = fixture(), after = structuredClone(before);
  after.tasks = [{ id: 'task', name: 'Install camera', project: 'project-a', assignedTo: 'employee-a', dueDate: '2026-10-10', status: 'Assigned', createdAt: now.toISOString() }];
  const synced = synchronizeNotifications(after, now, before, 'owner');
  assert.deepEqual(deliveredTo(synced.store, 'Task Assignment'), ['manager', 'tech-a']);
  assert.equal(inbox(synced.store, 'tech-b').length, 0);
  assert.equal(inbox(synced.store, 'client-b').length, 0);
  assert.equal(inbox(synced.store, 'tech-a').filter(row => row.type === 'Task Assignment').length, 1);
  assert.equal(synchronizeNotifications(synced.store, now, before, 'owner').changed, 0);
});

test('ticket status changes notify the affected client and assigned staff', () => {
  const before = fixture(), after = structuredClone(before);
  before.tickets = [{ id: 'ticket', name: 'Camera offline', customer: 'customer-a', project: 'project-a', technician: 'employee-a', status: 'Assigned' }];
  after.tickets = [{ ...before.tickets[0], status: 'Resolved', updatedAt: now.toISOString() }];
  const synced = synchronizeNotifications(after, now, before, 'tech-a');
  assert.deepEqual(deliveredTo(synced.store, 'Record Update'), ['client-a', 'manager', 'owner']);
  assert.match(inbox(synced.store, 'client-a').find(row => row.type === 'Record Update')!.message, /Resolved/);
});

test('new leads fall back to authorized sales staff when no active assigned account can access them', () => {
  const before = fixture(), after = structuredClone(before);
  after.leads = [{ id: 'renewal-lead', name: 'AMC renewal', assignedTo: 'employee-a', status: 'New', createdAt: now.toISOString() }];
  const synced = synchronizeNotifications(after, now, before);
  assert.deepEqual(deliveredTo(synced.store, 'New Lead'), ['manager', 'owner', 'sales']);
});

test('multiple assigned project members and authorized custom roles get their own inbox without notification module grants', () => {
  const before = fixture(), after = structuredClone(before);
  after.roles = [{ id: 'coordinator', name: 'Coordinator', allowedModules: ['projects'], permissions: ['view'], status: 'Active' }];
  after.users.push({ id: 'coordinator-user', name: 'Coordinator', role: 'coordinator', employee: 'coordinator-employee', status: 'Active' });
  after.projects[0] = { ...after.projects[0], technicians: ['employee-a', 'employee-b'], manager: 'coordinator-employee', updatedAt: now.toISOString() };
  const synced = synchronizeNotifications(after, now, before, 'owner');
  assert.deepEqual(deliveredTo(synced.store, 'Project Update'), ['client-a', 'coordinator-user', 'manager', 'sales', 'tech-a', 'tech-b']);
  assert.equal(inbox(synced.store, 'coordinator-user').filter(row => row.type === 'Project Update').length, 1);
});

test('project comments route through the parent project and preserve individual recipient IDs', () => {
  const before = fixture(), after = structuredClone(before);
  after.projectPosts = [{ id: 'post', project: 'project-a', name: 'Update discussion', kind: 'Comment', body: 'Installation approved', authorId: 'owner', authorName: 'Owner', createdAt: now.toISOString() }];
  const synced = synchronizeNotifications(after, now, before, 'owner');
  const rows = synced.store.notifications.filter(row => row.type === 'Project Comment');
  assert.deepEqual(rows.map(row => row.recipientUserId).sort(), ['client-a', 'manager', 'sales', 'tech-a']);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.ok(rows.every(row => row.openModule === 'projects' && row.openRecordId === 'project-a'));
});

test('recipients lose inbox access immediately when source access or field access is revoked', () => {
  let store = synchronizeNotifications(fixture(), now).store;
  store.roles = [{ id: 'finance-role', name: 'Accounts', allowedModules: ['projects', 'payments'], permissions: ['view'], hiddenFields: 'projects.paymentDueDate', status: 'Active' }];
  assert.equal(inbox(store, 'accounts').length, 0);
  store.roles[0].hiddenFields = '';
  assert.equal(inbox(store, 'accounts').length, 1);
  store.roles[0].allowedModules = ['projects'];
  assert.equal(inbox(store, 'accounts').length, 0);
  store.projects[0].deletedAt = now.toISOString();
  assert.equal(inbox(store, 'owner').length, 0);
  store = synchronizeNotifications(fixture(), now).store;
  const owner = memberIdentity(store.users[0], store), other = store.notifications.find(row => row.recipientUserId === 'accounts')!;
  assert.equal(canViewRecord(store, owner, 'notifications', other), false, 'even admins have personal inboxes');
  assert.ok(visibleStore(store, owner).notifications.every(row => row.recipientUserId === 'owner'));
});

test('resolved conditions disappear and a recurrence receives a fresh unread notification', () => {
  let store = synchronizeNotifications(fixture(), now).store;
  const original = inbox(store, 'owner')[0];
  const readDates = { [original.id]: now.toISOString() };
  assert.equal(inboxNotifications(store, memberIdentity(store.users[0], store), readDates)[0].read, true);
  store.payments[0].amount = 10000;
  store = synchronizeNotifications(store, now).store;
  assert.equal(inbox(store, 'owner').length, 0);
  store.payments[0].amount = 7500;
  store = synchronizeNotifications(store, now).store;
  assert.notEqual(inbox(store, 'owner')[0].id, original.id);
  assert.equal(inboxNotifications(store, memberIdentity(store.users[0], store), readDates)[0].read, false);
});

test('renewals respect disabled automation and escalate without daily duplicate inbox rows', () => {
  const store = fixture(); store.projects = [];
  store.amc = [{ id: 'amc', name: 'Customer AMC', customer: 'customer-a', endDate: '2026-10-30', status: 'Active' }];
  let synced = synchronizeNotifications(store, now);
  assert.ok(inbox(synced.store, 'owner').some(row => row.type === 'AMC Renewal'));
  const id = inbox(synced.store, 'owner')[0].id;
  synced = synchronizeNotifications(synced.store, new Date('2026-10-11T06:00:00Z'));
  assert.equal(inbox(synced.store, 'owner').length, 1);
  assert.equal(inbox(synced.store, 'owner')[0].id, id);
  assert.match(inbox(synced.store, 'owner')[0].message, /19 days/);
  synced = synchronizeNotifications(synced.store, new Date('2026-10-29T06:00:00Z'));
  assert.equal(inbox(synced.store, 'owner').length, 1);
  assert.notEqual(inbox(synced.store, 'owner')[0].id, id);
  synced.store.automations = [{ id: 'disabled', trigger: 'AMC Expiring', enabled: false }];
  assert.equal(inbox(synchronizeNotifications(synced.store, now).store, 'owner').length, 0);
});

test('the inbox contains all notifications beyond the previous 15-item limit and cannot be manually fabricated', () => {
  const store = fixture();
  store.tasks = Array.from({ length: 21 }, (_, i) => ({ id: `task-${i}`, name: `Assigned work ${i}`, assignedTo: 'employee-a', status: 'Assigned', dueDate: '2026-10-10' }));
  const synced = synchronizeNotifications(store, now);
  assert.equal(inbox(synced.store, 'tech-a').length, 21);
  assert.throws(() => applyMutation(store, 'notifications', 'create', { name: 'Made up', type: 'Payment Overdue' }), /read-only/);
});
