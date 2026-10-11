import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSeed } from '../lib/seed.ts';
import { DEMO_CONTENT_VERSION, migrateDemoContent } from '../lib/demo-content.ts';
import { migrateLeadProfiles } from '../lib/lead-profiles.ts';
import { resolveModules, type Store } from '../lib/schema.ts';
import { validateRecord, runAutomations } from '../lib/engine.ts';
import { synchronizeNotifications } from '../lib/notifications.ts';
import { initializeDatabase } from '../lib/hostinger/database.ts';
import { saveWorkspaceMigration } from '../lib/hostinger/workspace-migrations.ts';

function legacyWorkspace(): Store {
  const store = createSeed();
  delete store.settings[0].demoContentVersion;
  for (const role of store.roles) { role.demo = true; delete role.systemDefault; }
  store.users = [{ id: 'owner', name: 'Real administrator', role: 'ROLE-001', email: 'owner@example.com', status: 'Active' }];
  store.employees.unshift({ ...store.employees[0], id: 'EMP-001', name: 'Demo manager', email: 'manager@example.com', role: 'Manager' });
  store.employees.push({ ...store.employees[1], id: 'EMP-008', name: 'Other demo technician', email: 'other@example.com' });
  store.customers.push({ ...store.customers[0], id: 'CUS-002', name: 'Other demo company', profileLeadId: 'LEAD-002' });
  store.leads.push({ ...store.leads[0], id: 'LEAD-002', name: 'Other demo company', customer: 'CUS-002', project: 'PRJ-002' });
  store.contacts.push({ ...store.contacts[0], id: 'CON-002', customer: 'CUS-002' });
  store.sites.push({ ...store.sites[0], id: 'SITE-002', customer: 'CUS-002', contact: 'CON-002', technician: 'EMP-008', manager: 'EMP-001' });
  store.projects.push({ ...store.projects[0], id: 'PRJ-002', customer: 'CUS-002', lead: 'LEAD-002', site: 'SITE-002', manager: 'EMP-001', salesperson: 'EMP-001', technicians: ['EMP-008'] });
  store.tasks.push({ ...store.tasks[0], id: 'TASK-002', project: 'PRJ-002', assignedTo: 'EMP-008' });
  store.payments.push({ ...store.payments[0], id: 'PAY-002', project: 'PRJ-002', customer: 'CUS-002' });
  store.expenses.push({ ...store.expenses[0], id: 'EXP-002', project: 'PRJ-002' });
  store.expenses.push({ ...store.expenses[0], id: 'EXP-ARCHIVED', archivedAt: '2026-10-05T09:00:00Z' });
  store.expenses.push({ ...store.expenses[0], id: 'EXP-DELETED', deletedAt: '2026-10-05T09:00:00Z' });
  // Kept demos must be relinked when their related example is removed.
  store.notes[0].relatedId = 'PRJ-002';
  store.workOrders[0].products = ['PROD-001', 'PROD-002'];
  store.products.push({ ...store.products[0], id: 'PROD-002', sku: 'DEMO-SECOND' });
  return store;
}

function assertLinked(store: Store) {
  for (const definition of resolveModules(store)) {
    for (const row of store[definition.id] || []) {
      for (const field of definition.fields.filter(field => field.relation)) {
        const value = row[field.key], ids = Array.isArray(value) ? value : [value];
        for (const id of ids) if (id) assert.ok(store[field.relation!]?.some(target => target.id === id), `${definition.id}.${field.key} references ${id}`);
      }
    }
  }
  for (const customer of store.customers) if (customer.profileLeadId) assert.ok(store.leads.some(lead => lead.id === customer.profileLeadId));
}

test('new workspaces have one valid linked example per populated module and all functional roles', () => {
  const store = createSeed();
  for (const definition of resolveModules(store)) {
    assert.ok((store[definition.id] || []).filter(row => row.demo === true).length <= 1, `${definition.id} has too many samples`);
    for (const row of store[definition.id] || []) assert.deepEqual(validateRecord(definition.id, row, store, row), [], definition.id);
  }
  assertLinked(store);
  assert.equal(store.roles.length, 11);
  assert.ok(store.roles.every(role => role.demo !== true && role.status === 'Active'));
  assert.equal(store.users.length, 1);
  assert.equal(store.leads.length, 1);
  assert.equal(store.customers.length, 1);
  assert.equal(store.settings[0].demoContentVersion, DEMO_CONTENT_VERSION);
  assert.equal(migrateLeadProfiles(store), false, 'company migration does not duplicate the example');
  for (const id of ['documents', 'notifications', 'backups']) assert.deepEqual(store[id], [], 'real uploads/events/backups are required');
});

test('sample records do not create real notifications or renewal records', () => {
  const store = createSeed(), now = new Date('2026-10-11T12:00:00Z');
  assert.equal(runAutomations(store, now).created, 0);
  const result = synchronizeNotifications(store, now);
  assert.deepEqual(result.store.notifications, []);
});

test('legacy cleanup removes surplus demos including archived/deleted samples and repairs sample links', () => {
  const store = legacyWorkspace(), owner = structuredClone(store.users[0]);
  assert.equal(migrateDemoContent(store), true);
  for (const [moduleId, rows] of Object.entries(store)) assert.ok(rows.filter(row => row.demo === true).length <= 1, moduleId);
  assertLinked(store);
  assert.deepEqual(store.users[0], owner);
  assert.equal(store.notes[0].relatedId, 'PRJ-001');
  assert.deepEqual(store.workOrders[0].products, ['PROD-001']);
  assert.equal(store.employees[0].id, 'EMP-004');
  assert.equal(store.projects[0].paidAmount, 142500);
  assert.equal(store.projects[0].balanceDue, 142500);
  assert.equal(store.projects[0].actualCost, 156000);
  assert.equal(migrateLeadProfiles(store), false, 'cleaned companies never recreate deleted profiles');
});

test('real records retain their original sample references and transitive dependencies', () => {
  const store = legacyWorkspace();
  const realPayment = { id: 'real-payment', name: 'Actual receipt', project: 'PRJ-002', customer: 'CUS-002', date: '2026-10-11', amount: 1000, status: 'Received' };
  store.payments.push(structuredClone(realPayment));
  assert.equal(migrateDemoContent(store), true);
  assert.deepEqual(store.payments.find(row => row.id === realPayment.id), realPayment);
  assert.equal(store.projects.length, 1, 'the genuinely referenced example is preferred');
  assert.equal(store.projects[0].id, 'PRJ-002');
  assert.deepEqual(store.projects[0].technicians, ['EMP-008']);
  assert.equal(store.customers[0].id, 'CUS-002');
  assert.ok(store.employees.some(row => row.id === 'EMP-001'));
  assert.ok(store.employees.some(row => row.id === 'EMP-008'));
  assertLinked(store);
});

test('multiple samples referenced by real records are preserved without relabeling them as real', () => {
  const store = legacyWorkspace();
  const notes = ['PRJ-001', 'PRJ-002'].map((project, index) => ({ id: `real-note-${index}`, name: 'Actual note', relatedModule: 'projects', relatedId: project, content: 'Actual project history' }));
  store.notes.push(...structuredClone(notes));
  migrateDemoContent(store);
  assert.deepEqual(store.notes.filter(row => row.demo !== true), notes);
  assert.equal(store.projects.length, 2);
  assert.ok(store.projects.every(row => row.demo === true));
  assertLinked(store);
});

test('credentialed accounts retain access and employee/client mappings even when still marked as demos', () => {
  const store = legacyWorkspace();
  store.users.push({ id: 'configured-client', name: 'Configured client', email: 'client@example.com', role: 'ROLE-011', customer: 'CUS-002', status: 'Active', demo: true });
  store.users.push({ id: 'managed-tech', name: 'Managed technician', email: 'tech@example.com', role: 'ROLE-005', employee: 'EMP-008', status: 'Active', demo: true });
  migrateDemoContent(store, ['configured-client', 'managed-tech']);
  assert.ok(store.users.some(row => row.id === 'configured-client' && row.customer === 'CUS-002'));
  assert.ok(store.users.some(row => row.id === 'managed-tech' && row.employee === 'EMP-008'));
  assert.ok(store.roles.some(row => row.id === 'ROLE-011' && row.status === 'Active'));
  assert.ok(store.roles.some(row => row.id === 'ROLE-005' && row.status === 'Active'));
  assertLinked(store);
});

test('custom relation fields and custom module definitions used by real records survive cleanup', () => {
  const store = legacyWorkspace();
  store.customModules = [{ id: 'demo-custom-module', moduleId: 'visits', name: 'Visits', singular: 'Visit', status: 'Active', demo: true }];
  store.customFields.push({ id: 'custom-site', name: 'Site', moduleId: 'visits', key: 'visitSite', type: 'relation', relation: 'sites', status: 'Active' });
  store.visits = [{ id: 'real-visit', name: 'Actual visit', visitSite: 'SITE-002' }];
  migrateDemoContent(store);
  assert.equal(store.visits[0].visitSite, 'SITE-002');
  assert.equal(store.sites[0].id, 'SITE-002');
  assert.equal(store.customModules[0].id, 'demo-custom-module');
  assertLinked(store);
});

test('cleanup is idempotent and never recreates removed examples or deletes later imports', () => {
  const store = legacyWorkspace();
  migrateDemoContent(store);
  const snapshot = JSON.stringify(store);
  assert.equal(migrateDemoContent(store), false);
  assert.equal(JSON.stringify(store), snapshot);
  store.tasks = [];
  store.customers.push({ id: 'imported-demo', name: 'Explicit later import', demo: true });
  assert.equal(migrateDemoContent(store), false);
  assert.deepEqual(store.tasks, []);
  assert.ok(store.customers.some(row => row.id === 'imported-demo'));
});

test('migration saves the exact encrypted original and cleanup together without changing authentication', () => {
  const database = new DatabaseSync(':memory:');
  try {
    initializeDatabase(database);
    const original = JSON.stringify({ vault: [{ id: 'secret', secretCipher: 'encrypted-original' }] });
    const cleaned = JSON.stringify({ settings: [{ id: 'company', demoContentVersion: 1 }] });
    database.prepare('INSERT INTO erp_workspace (id, data, revision, updated_at) VALUES (?, ?, ?, ?)').run('main', original, 7, '2026-10-01');
    database.prepare('INSERT INTO auth_passwords (member_id, password_hash) VALUES (?, ?)').run('owner', 'existing-password-hash');
    assert.equal(saveWorkspaceMigration(database, cleaned, 7, 'demo-content-v1'), 8);
    const current = database.prepare('SELECT data, revision FROM erp_workspace WHERE id = ?').get('main');
    assert.equal(current?.data, cleaned);
    assert.equal(current?.revision, 8);
    const snapshot = database.prepare('SELECT data, revision FROM erp_workspace_migrations').get();
    assert.equal(snapshot?.data, original);
    assert.equal(snapshot?.revision, 7);
    assert.equal(database.prepare('SELECT password_hash FROM auth_passwords').get()?.password_hash, 'existing-password-hash');
  } finally { database.close(); }
});

test('a stale migration cannot overwrite a concurrent edit or leave a snapshot behind', () => {
  const database = new DatabaseSync(':memory:');
  try {
    initializeDatabase(database);
    database.prepare('INSERT INTO erp_workspace (id, data, revision, updated_at) VALUES (?, ?, ?, ?)').run('main', 'latest data', 4, '2026-10-11');
    assert.throws(() => saveWorkspaceMigration(database, 'stale cleanup', 3, 'demo-content-v1'), /CONFLICT:/);
    assert.equal(database.prepare('SELECT data FROM erp_workspace').get()?.data, 'latest data');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM erp_workspace_migrations').get()?.count, 0);
  } finally { database.close(); }
});
