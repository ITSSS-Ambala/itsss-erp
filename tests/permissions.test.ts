import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore -- Native Node 24 TypeScript import.
import { resolveRole, permit, visibleStore, canViewRecord, assertMutationAccess, canDownloadFile, validatedRestore, type AccessUser } from '../lib/access.ts';
// @ts-ignore -- Native Node 24 TypeScript import.
import { modules, type Store } from '../lib/schema.ts';

function fixture(): Store {
  const store: Store = Object.fromEntries(modules.map(module => [module.id, []]));
  store.roles = [
    { id: 'role-admin', name: 'Super Admin', permissions: ['View', 'Add', 'Edit', 'Delete', 'Approve', 'Download', 'Export'], allowedModules: '*', status: 'Active' },
    { id: 'role-tech', name: 'Technician', permissions: ['View', 'Add', 'Edit', 'Download'], allowedModules: '*', status: 'Active' },
    { id: 'role-client', name: 'Client', permissions: ['View', 'Download'], allowedModules: '*', status: 'Active' },
    { id: 'role-inventory', name: 'Inventory', permissions: ['View', 'Add', 'Edit', 'Download'], allowedModules: '*', status: 'Active' },
    { id: 'role-custom', name: 'CRM Reviewer', permissions: ['View', 'Download'], allowedModules: 'leads', hiddenFields: 'leads.mobile,leads.email', status: 'Active' },
  ];
  store.users = [{ id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'role-admin', status: 'Active' }];
  store.employees = [{ id: 'tech-a', name: 'Assigned technician', role: 'Technician', status: 'Active', salary: 30000 }, { id: 'tech-b', name: 'Other technician', role: 'Technician', status: 'Active' }];
  store.customers = [{ id: 'customer-a', name: 'Own customer', lifetimeProfit: 5000 }, { id: 'customer-b', name: 'Other customer' }];
  store.sites = [{ id: 'site-a', name: 'Own site', customer: 'customer-a', technician: 'tech-a' }, { id: 'site-b', name: 'Other site', customer: 'customer-b', technician: 'tech-b' }];
  store.projects = [{ id: 'project-a', name: 'Own project', customer: 'customer-a', site: 'site-a', value: 10000, estimatedCost: 3000, actualCost: 2000, profit: 8000, margin: 80, technicians: ['tech-a'], status: 'Planning' }, { id: 'project-b', name: 'Other project', customer: 'customer-b', site: 'site-b', value: 10000, technicians: ['tech-b'], status: 'Planning' }];
  store.technicianJobs = [{ id: 'job-a', name: 'Own job', project: 'project-a', site: 'site-a', customer: 'customer-a', technician: 'tech-a', status: 'Assigned' }, { id: 'job-b', name: 'Other job', project: 'project-b', site: 'site-b', customer: 'customer-b', technician: 'tech-b', notes: 'tech-a', status: 'Assigned' }];
  store.products = [{ id: 'product-a', sku: 'SKU-1', name: 'Camera', purchasePrice: 200, sellingPrice: 300 }];
  store.inventory = [{ id: 'stock-a', name: 'Camera stock', product: 'product-a', location: 'Warehouse', quantity: 10, reserved: 0, damaged: 0, unitCost: 200 }];
  store.payments = [{ id: 'payment-a', name: 'Own receipt', project: 'project-a', customer: 'customer-a', amount: 500, date: '2026-10-06', status: 'Received' }, { id: 'payment-b', name: 'Other receipt', project: 'project-b', customer: 'customer-b', amount: 1000, date: '2026-10-06', status: 'Received' }];
  store.leads = [{ id: 'lead-a', name: 'Prospect', mobile: '9876543210', email: 'lead@example.com', status: 'New' }];
  store.notes = [{ id: 'note-private', name: 'Private note', content: 'Private content', type: 'Private', relatedModule: 'customers', relatedId: 'customer-a', author: 'tech-b', createdById: 'other-user' }];
  store.auditLogs = [{ id: 'audit-existing', name: 'Existing audit', actor: 'Owner', action: 'create', module: 'leads' }];
  store.settings = [{ id: 'company', name: 'ITSSS', currency: 'INR', theme: 'Light', demo: true }];
  return store;
}
const technician: AccessUser = { userId: 'user-tech', displayName: 'Assigned technician', role: 'Technician', employee: 'tech-a' };
const client: AccessUser = { userId: 'user-client', displayName: 'Customer user', role: 'Client', customer: 'customer-a' };
const admin: AccessUser = { userId: 'owner', displayName: 'Owner', email: 'owner@example.com', role: 'Super Admin', memberId: 'owner' };

test('role relation IDs resolve and disabled or unknown roles fail closed', () => {
  const store = fixture();
  assert.equal(resolveRole('role-tech', store), 'Technician');
  assert.equal(resolveRole('Technician', store), 'Technician');
  assert.equal(resolveRole('missing-role', store), 'Unassigned');
  store.roles.find(role => role.id === 'role-tech')!.status = 'Inactive';
  assert.equal(resolveRole('role-tech', store), 'Unassigned');
  assert.equal(permit('role-tech', 'technicianJobs', 'view', store), false);
});

test('custom role module allowlists, action casing and hidden fields apply', () => {
  const store = fixture();
  assert.equal(permit('role-custom', 'leads', 'view', store), true);
  assert.equal(permit('role-custom', 'leads', 'add', store), false);
  assert.equal(permit('role-custom', 'projects', 'view', store), false);
  const result = visibleStore(store, { userId: 'reviewer', displayName: 'Reviewer', role: 'CRM Reviewer' });
  assert.equal(result.leads.length, 1);
  assert.equal('mobile' in result.leads[0], false);
  assert.equal('email' in result.leads[0], false);
  assert.equal(result.users, undefined);
});

test('technician visibility uses explicit assignments and filters related customers and sites', () => {
  const store = fixture(), result = visibleStore(store, technician);
  assert.deepEqual(result.technicianJobs.map(row => row.id), ['job-a']);
  assert.deepEqual(result.projects.map(row => row.id), ['project-a']);
  assert.deepEqual(result.customers.map(row => row.id), ['customer-a']);
  assert.deepEqual(result.sites.map(row => row.id), ['site-a']);
  assert.equal(result.payments, undefined);
  assert.equal(result.users, undefined);
  assert.equal('profit' in result.projects[0], false);
  assert.equal('actualCost' in result.projects[0], false);
  assert.equal('purchasePrice' in result.products[0], false);
  assert.equal('salary' in result.employees[0], false);
  assert.equal(result.notes.length, 0);
});

test('unmapped technicians and clients cannot see company records', () => {
  const store = fixture();
  const tech = visibleStore(store, { ...technician, employee: undefined });
  const customer = visibleStore(store, { ...client, customer: undefined });
  assert.equal(tech.technicianJobs.length, 0);
  assert.equal(tech.customers.length, 0);
  assert.equal(customer.projects.length, 0);
  assert.equal(customer.payments.length, 0);
});

test('clients can view their own payments and projects while unrelated records remain private', () => {
  const result = visibleStore(fixture(), client);
  assert.deepEqual(result.projects.map(row => row.id), ['project-a']);
  assert.deepEqual(result.payments.map(row => row.id), ['payment-a']);
  assert.equal('actualCost' in result.projects[0], false);
  assert.equal('profit' in result.projects[0], false);
  assert.equal(permit('Client', 'payments', 'edit', fixture()), false);
});

test('technicians cannot update other jobs, reassign work or attach inaccessible customers', () => {
  const store = fixture();
  assert.throws(() => assertMutationAccess(store, technician, 'technicianJobs', 'update', { status: 'Work Started' }, store.technicianJobs[1]), /FORBIDDEN/);
  assert.throws(() => assertMutationAccess(store, technician, 'technicianJobs', 'update', { technician: 'tech-b' }, store.technicianJobs[0]), /FORBIDDEN/);
  assert.throws(() => assertMutationAccess(store, technician, 'technicianJobs', 'update', { customer: 'customer-b' }, store.technicianJobs[0]), /FORBIDDEN/);
  assert.doesNotThrow(() => assertMutationAccess(store, technician, 'technicianJobs', 'update', { status: 'Work Started' }, store.technicianJobs[0]));
});

test('approval permission is required for approved status as well as approvalStatus', () => {
  const store = fixture();
  const inventory: AccessUser = { userId: 'inventory', displayName: 'Stock manager', role: 'Inventory' };
  assert.throws(() => assertMutationAccess(store, inventory, 'purchaseOrders', 'create', { name: 'PO-1', status: 'Approved' }), /Approval permission/);
  assert.throws(() => assertMutationAccess(store, inventory, 'allocations', 'create', { name: 'AL-1', status: 'Reserved', approvalStatus: 'Approved' }), /Approval permission/);
  const receipt = { id: 'receipt-1', name: 'Receipt', status: 'Received', location: 'Warehouse', quantity: 10 };
  store.roles.find(role => role.name === 'Inventory')!.permissions.push('Delete');
  assert.throws(() => assertMutationAccess(store, inventory, 'purchases', 'update', { status: 'Draft' }, receipt), /Approval permission/);
  assert.throws(() => assertMutationAccess(store, inventory, 'purchases', 'update', { location: 'Shop' }, receipt), /Approval permission/);
  assert.throws(() => assertMutationAccess(store, inventory, 'purchases', 'delete', {}, receipt), /Approval permission/);
  assert.doesNotThrow(() => assertMutationAccess(store, inventory, 'purchases', 'update', { notes: 'Delivery inspected' }, receipt));
  assert.doesNotThrow(() => assertMutationAccess(store, inventory, 'purchaseOrders', 'create', { name: 'PO-1', status: 'Draft', approvalStatus: 'Pending' }));
});

test('file downloads require a visible linked record or creator ownership', () => {
  const store = fixture(), key = 'files/file-id/photo.png';
  store.technicianJobs[0].installationPhotos = [{ key }];
  assert.equal(canDownloadFile(store, technician, key, { module: 'technicianJobs', recordId: 'job-b', creatorId: 'other-user' }), false);
  assert.equal(canDownloadFile(store, technician, key, { module: 'technicianJobs', recordId: 'job-a', creatorId: 'other-user' }), true);
  assert.equal(canDownloadFile(store, technician, key, { module: 'documents', creatorId: technician.userId }), true);
  store.documents.push({ id: 'document-a', name: 'Own file', relatedModule: 'projects', relatedId: 'project-a', file: [{ key }] });
  assert.equal(canDownloadFile(store, client, key, { module: 'documents', creatorId: 'other-user' }), true);
  assert.equal(canDownloadFile(store, { ...client, customer: 'customer-b' }, key, { module: 'documents', creatorId: 'other-user' }), false);
});

test('history cannot be mutated even by an administrator', () => {
  const store = fixture();
  for (const moduleId of ['auditLogs', 'activities', 'stockHistory']) {
    assert.equal(permit(admin.role, moduleId, 'edit', store), false);
    assert.equal(permit(admin.role, moduleId, 'delete', store), false);
    assert.equal(permit(admin.role, moduleId, 'view', store), true);
  }
});

test('missing employee mappings never make an unassigned private note public', () => {
  const store = fixture();
  store.notes.push({ id: 'private-unassigned', name: 'Private note', content: 'Private content', type: 'Private', createdById: 'other-user' });
  const viewer: AccessUser = { userId: 'viewer', displayName: 'Viewer', role: 'Viewer' };
  assert.equal(visibleStore(store, viewer).notes.length, 0);
  assert.equal(canDownloadFile(store, { ...technician, employee: undefined }, 'files/file-id/file.txt', { module: 'documents', creatorId: technician.userId }), false);
});

test('a validated restore preserves membership and audit history and recalculates balances', () => {
  const current = fixture(), snapshot = structuredClone(current);
  snapshot.users = [{ id: 'attacker', name: 'New owner', email: 'other@example.com', role: 'role-admin', status: 'Active' }];
  snapshot.auditLogs = [];
  snapshot.projects[0].profit = 999999;
  const restored = validatedRestore(snapshot, current);
  assert.deepEqual(restored.users, current.users);
  assert.deepEqual(restored.auditLogs, current.auditLogs);
  assert.equal(restored.projects[0].balanceDue, 9500);
  assert.equal(restored.projects[0].profit, 10000);
  assert.equal(snapshot.users[0].id, 'attacker', 'validation never mutates uploaded input');
});

test('restore rejects negative stock, broken relations, duplicate IDs and unknown modules', () => {
  const current = fixture();
  const negative = structuredClone(current); negative.inventory[0].quantity = -1;
  assert.throws(() => validatedRestore(negative, current), /validation failed/);
  const missing = structuredClone(current); missing.payments[0].project = 'missing-project';
  assert.throws(() => validatedRestore(missing, current), /validation failed/);
  const duplicate = structuredClone(current); duplicate.customers.push({ ...duplicate.customers[0] });
  assert.throws(() => validatedRestore(duplicate, current), /duplicate/);
  const unknown = structuredClone(current); unknown.unknownModule = [];
  assert.throws(() => validatedRestore(unknown, current), /unknown module/);
});

test('restore retains historical references to records already in the recycle bin', () => {
  const current = fixture();
  const snapshot = structuredClone(current);
  snapshot.customers[0].deletedAt = '2026-10-06T12:00:00Z';
  const restored = validatedRestore(snapshot, current);
  assert.equal(restored.projects[0].customer, 'customer-a');
  assert.equal(restored.customers[0].deletedAt, '2026-10-06T12:00:00Z');
});
