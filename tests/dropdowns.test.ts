import test from 'node:test';
import assert from 'node:assert/strict';
import { createDropdownOption } from '../lib/dropdowns.ts';
import { assertMutationAccess, canCreateDropdownOption, dropdownPermissionsFor, permit, visibleStore, type AccessUser } from '../lib/access.ts';
import { applyMutation, validateRecord } from '../lib/engine.ts';
import { getDropdownConfig, modules, resolveModules, type Field, type Store } from '../lib/schema.ts';

const admin: AccessUser = { userId: 'owner', displayName: 'Owner', role: 'Super Admin' };
const sales: AccessUser = { userId: 'sales', displayName: 'Sales colleague', role: 'Sales' };
const accounts: AccessUser = { userId: 'accounts', displayName: 'Accounts colleague', role: 'Accounts' };
function fixture(): Store {
  const store: Store = Object.fromEntries(modules.map(module => [module.id, []]));
  store.roles = [
    { id: 'admin-role', name: 'Super Admin', permissions: ['View', 'Add', 'Edit', 'Delete', 'Approve'], allowedModules: '*', status: 'Active' },
    { id: 'sales-role', name: 'Sales', permissions: ['View', 'Add', 'Edit'], allowedModules: 'leads,customers,contacts,projects,employees,sites,tasks', status: 'Active' },
    { id: 'accounts-role', name: 'Accounts', permissions: ['View', 'Add', 'Edit', 'Approve'], allowedModules: 'payments,expenses,supplierPayments,income,customers,projects', status: 'Active' },
    { id: 'viewer-role', name: 'Reviewer', permissions: ['View'], allowedModules: 'leads,customers', status: 'Active' },
    { id: 'hidden-role', name: 'Restricted editor', permissions: ['View', 'Add', 'Edit'], allowedModules: 'leads', hiddenFields: 'leads.source', status: 'Active' },
    { id: 'parent-role', name: 'Lead editor', permissions: { leads: ['View', 'Edit'], customers: ['View'] }, allowedModules: 'leads,customers', status: 'Active' },
  ];
  store.customers = [{ id: 'customer-a', name: 'Sample customer', status: 'Active' }];
  store.employees = [{ id: 'employee-a', name: 'Sample employee', role: 'Sales', status: 'Active' }];
  store.projects = [{ id: 'project-a', name: 'Sample project', customer: 'customer-a', value: 10000, status: 'Planning' }];
  return store;
}
const field = (store: Store, moduleId: string, key: string): Field => resolveModules(store).find(module => module.id === moduleId)!.fields.find(item => item.key === key)!;
const add = (store: Store, moduleId: string, fieldKey: string, name: unknown, user = sales, expectedRevision: unknown = 7, revision = 7) => createDropdownOption(store, user, { moduleId, fieldKey, name, expectedRevision, revision });

test('a salesperson persists an inline lead source globally without settings access', () => {
  const store = fixture(), before = structuredClone(store);
  assert.equal(permit(sales.role, 'categories', 'add', store), false);
  const result = add(store, 'leads', 'source', '  Trade   Fair  ');
  assert.equal(result.value, 'Trade Fair');
  assert.equal(result.reused, false);
  assert.deepEqual(store, before, 'option creation preserves the live input until commit');
  assert.equal(result.store.categories[0].type, 'Lead Source');
  assert.equal(result.store.categories[0].createdById, sales.userId);
  assert.ok(field(structuredClone(result.store), 'leads', 'source').options!.includes('Trade Fair'));
  assert.ok(result.store.auditLogs.some(row => row.module === 'categories' && row.actor === sales.displayName));
});

test('trim, Unicode normalization and casefold reuse one canonical saved choice', () => {
  const first = add(fixture(), 'leads', 'source', 'Trade Fair');
  const reused = add(first.store, 'leads', 'source', '  ＴＲＡＤＥ   ＦＡＩＲ  ');
  assert.equal(reused.value, 'Trade Fair');
  assert.equal(reused.reused, true);
  assert.equal(reused.store, first.store);
  assert.equal(reused.store.categories.length, 1);
  assert.equal(reused.store.auditLogs.length, first.store.auditLogs.length);
  const builtIn = add(first.store, 'leads', 'source', ' google ads ');
  assert.equal(builtIn.value, 'Google Ads');
  assert.equal(builtIn.reused, true);
});

test('ordinary business option values persist only on their own field', () => {
  const result = add(fixture(), 'contacts', 'type', 'Procurement');
  assert.equal(result.store.dropdownOptions[0].moduleId, 'contacts');
  assert.equal(result.store.dropdownOptions[0].fieldKey, 'type');
  assert.ok(field(result.store, 'contacts', 'type').options!.includes('Procurement'));
  assert.equal(field(result.store, 'leads', 'type').options!.includes('Procurement'), false);
  assert.deepEqual(validateRecord('contacts', { name: 'Buyer', customer: 'customer-a', type: 'Procurement' }, result.store), []);
  assert.ok(validateRecord('contacts', { name: 'Buyer', type: 'Unsaved arbitrary value' }, result.store).some(error => /configured options/.test(error)));
});

test('shared dictionaries work in every linked business field after refresh', () => {
  let result = add(fixture(), 'payments', 'method', 'NEFT', accounts);
  for (const moduleId of ['payments', 'supplierPayments', 'expenses', 'income']) assert.ok(field(structuredClone(result.store), moduleId, 'method').options!.includes('NEFT'));
  result = add(result.store, 'customers', 'city', 'Zirakpur');
  for (const moduleId of ['customers', 'leads', 'sites', 'projects', 'suppliers', 'employees']) assert.ok(field(structuredClone(result.store), moduleId, 'city').options!.includes('Zirakpur'));
  result = add(result.store, 'employees', 'department', 'Field Engineering', admin);
  assert.ok(field(result.store, 'projects', 'department').options!.includes('Field Engineering'));
  result = add(result.store, 'inventory', 'location', 'Regional Store', admin);
  for (const key of ['fromLocation', 'toLocation']) assert.ok(field(result.store, 'stockTransfers', key).options!.includes('Regional Store'));
});

test('configurable operational statuses are saved as workflow definitions', () => {
  const result = add(fixture(), 'projects', 'status', 'Awaiting Customer Access');
  assert.equal(result.store.customStatuses[0].moduleId, 'projects');
  assert.equal(result.store.customStatuses[0].terminal, false);
  assert.ok(resolveModules(result.store).find(module => module.id === 'projects')!.statuses!.includes(result.value));
  assert.deepEqual(validateRecord('projects', { name: 'Customer rollout', value: 100, status: result.value }, result.store), []);
});

test('financial workflow, implementation and security enums remain fixed even for administrators', () => {
  const store = fixture();
  for (const [moduleId, key] of [['payments', 'status'], ['payments', 'type'], ['expenses', 'status'], ['expenses', 'approvalStatus'], ['recurring', 'cycle'], ['commissions', 'type'], ['roles', 'permissions'], ['customFields', 'type'], ['automations', 'trigger'], ['automations', 'action'], ['settings', 'theme'], ['categories', 'type'], ['notes', 'type'], ['communication', 'channel']]) {
    assert.equal(getDropdownConfig(moduleId, field(store, moduleId, key)), undefined, `${moduleId}.${key}`);
    assert.equal(field(store, moduleId, key).allowCustom, false, `${moduleId}.${key}`);
    assert.throws(() => add(store, moduleId, key, 'Unsupported', admin), /fixed system options/);
  }
});

test('settings CRUD cannot inject arbitrary fixed-field or financial status options', () => {
  const store = fixture();
  assert.throws(() => applyMutation(store, 'dropdownOptions', 'create', { name: 'Weekly', moduleId: 'recurring', fieldKey: 'cycle', status: 'Active' }), /does not allow configurable options/);
  assert.throws(() => applyMutation(store, 'customStatuses', 'create', { name: 'Paid without approval', moduleId: 'expenses', status: 'Active' }), /does not allow configurable options/);
  assert.throws(() => applyMutation(store, 'categories', 'create', { name: 'Value', type: 'Unknown dictionary', status: 'Active' }), /configured options/);
});

test('view-only users, hidden fields and inaccessible parent modules cannot add values', () => {
  const store = fixture();
  const reviewer: AccessUser = { userId: 'reviewer', displayName: 'Reviewer', role: 'Reviewer' };
  const restricted: AccessUser = { userId: 'restricted', displayName: 'Restricted editor', role: 'Restricted editor' };
  for (const user of [reviewer, restricted]) assert.throws(() => add(store, 'leads', 'source', 'New source', user), /FORBIDDEN/);
  assert.throws(() => add(store, 'products', 'category', 'New product category', sales), /FORBIDDEN/);
  assert.equal(dropdownPermissionsFor(store, reviewer).leads.source, false);
  assert.equal(dropdownPermissionsFor(store, restricted).leads.source, false);
});

test('edit permission on the parent is sufficient for an ordinary business dictionary', () => {
  const store = fixture(), user: AccessUser = { userId: 'editor', displayName: 'Lead editor', role: 'Lead editor' };
  assert.equal(permit(user.role, 'leads', 'add', store), false);
  assert.equal(permit(user.role, 'leads', 'edit', store), true);
  assert.equal(add(store, 'leads', 'source', 'Partner event', user).value, 'Partner event');
});

test('nested relation creation requires parent write and child view and add', () => {
  const store = fixture(), user: AccessUser = { userId: 'editor', displayName: 'Lead editor', role: 'Lead editor' };
  assert.equal(canCreateDropdownOption(store, sales, 'leads', field(store, 'leads', 'customer')), true);
  assert.equal(canCreateDropdownOption(store, sales, 'leads', field(store, 'leads', 'assignedTo')), false);
  assert.equal(canCreateDropdownOption(store, user, 'leads', field(store, 'leads', 'customer')), false);
  assert.throws(() => add(store, 'leads', 'customer', 'Incomplete customer', sales), /complete form/);
  const data = { name: 'Inline customer', city: 'Ambala', status: 'Active' };
  assert.doesNotThrow(() => assertMutationAccess(store, sales, 'customers', 'create', data));
  const created = applyMutation(store, 'customers', 'create', data);
  assert.deepEqual(validateRecord('leads', { name: 'Buyer', mobile: '9876543210', customer: created.record.id }, created.store), []);
  assert.throws(() => assertMutationAccess(store, user, 'customers', 'create', data), /FORBIDDEN/);
});

test('employee role additions require a complete authorization definition', () => {
  const store = fixture();
  assert.equal(field(store, 'employees', 'role').allowCustom, false);
  assert.equal(canCreateDropdownOption(store, admin, 'employees', field(store, 'employees', 'role')), true);
  assert.equal(canCreateDropdownOption(store, sales, 'employees', field(store, 'employees', 'role')), false);
  assert.throws(() => add(store, 'employees', 'role', 'Unconfigured privilege', admin), /fixed system options/);
  const added = applyMutation(store, 'roles', 'create', { name: 'Field Coordinator', permissions: ['View', 'Add'], allowedModules: 'tasks', status: 'Active' });
  assert.ok(field(added.store, 'employees', 'role').options!.includes('Field Coordinator'));
  assert.deepEqual(validateRecord('users', { name: 'Team member', email: 'member@example.com', role: added.record.id, status: 'Active' }, added.store), []);
});

test('custom select, radio and multiple-choice fields share persisted inline support', () => {
  const store = fixture();
  store.customFields = ['select', 'radio', 'multiselect'].map((type, index) => ({ id: `custom-${index}`, name: `Business choice ${index}`, moduleId: 'leads', key: `choice${index}`, type, options: 'Existing', status: 'Active' }));
  let next = store;
  for (let index = 0; index < 3; index++) {
    const result = add(next, 'leads', `choice${index}`, 'Inline value');
    next = result.store;
    assert.ok(field(structuredClone(next), 'leads', `choice${index}`).options!.includes('Inline value'));
  }
  const valid = { name: 'Prospect', mobile: '9876543210', choice0: 'Inline value', choice1: 'Inline value', choice2: ['Existing', 'Inline value'] };
  assert.deepEqual(validateRecord('leads', valid, next), []);
  assert.ok(validateRecord('leads', { ...valid, choice1: '__create_new__' }, next).some(error => /configured options/.test(error)));
  for (const invalid of ['Existing', ['Unknown'], ['Existing', 'Existing'], [1]]) assert.ok(validateRecord('leads', { ...valid, choice2: invalid }, next).some(error => /configured options|unique selections/.test(error)));
});

test('relation multiple selections validate types, uniqueness and linked records', () => {
  const store = fixture(), data = { name: 'Project', value: 100, technicians: ['employee-a'] };
  assert.deepEqual(validateRecord('projects', data, store), []);
  for (const invalid of ['employee-a', ['employee-a', 'employee-a'], ['missing'], [1]]) assert.ok(validateRecord('projects', { ...data, technicians: invalid }, store).length > 0);
});

test('relation-backed custom select and radio fields validate record IDs rather than labels', () => {
  const store = fixture();
  store.customFields = ['select', 'radio'].map((type, index) => ({ id: `relation-${index}`, name: `Related customer ${index}`, moduleId: 'leads', key: `relation${index}`, type, relation: 'customers', options: 'Unused label', status: 'Active' }));
  const data = { name: 'Prospect', mobile: '9876543210', relation0: 'customer-a', relation1: 'customer-a' };
  assert.deepEqual(validateRecord('leads', data, store), []);
  assert.ok(validateRecord('leads', { ...data, relation0: 'Unused label' }, store).some(error => /missing or deleted/.test(error)));
  assert.equal(getDropdownConfig('leads', field(store, 'leads', 'relation1'))!.kind, 'relation');
});

test('option labels reject missing, oversized, control and create-command values', () => {
  const store = fixture();
  for (const value of [undefined, null, 1, {}, '', '   ', 'x'.repeat(81), 'Bad\nvalue', '__create_new__', '__ADD_VALUE__']) assert.throws(() => add(store, 'leads', 'source', value), /visible characters/);
  assert.throws(() => add(store, 'missing', 'source', 'Label'), /Unknown dropdown/);
  assert.throws(() => add(store, 'leads', 'missing', 'Label'), /Unknown dropdown/);
  assert.equal(store.categories.length, 0);
});

test('stale or type-mismatched workspace revisions fail before any option mutation', () => {
  const store = fixture(), before = structuredClone(store);
  for (const expected of [6, 8, undefined, '7']) assert.throws(() => createDropdownOption(store, sales, { moduleId: 'leads', fieldKey: 'source', name: 'Trade Fair', expectedRevision: expected, revision: 7 }), /CONFLICT/);
  assert.deepEqual(store, before);
  assert.equal(add(store, 'leads', 'source', 'Google Ads', sales, 7, 7).reused, true);
});

test('non-admin refresh preserves permitted choices without exposing settings records', () => {
  let store = add(fixture(), 'leads', 'source', 'Trade Fair').store;
  store = add(store, 'products', 'category', 'Hidden product classification', admin).store;
  const visible = visibleStore(store, sales);
  assert.equal(visible.categories, undefined);
  assert.equal(permit(sales.role, 'dropdownOptions', 'view', store), false);
  assert.ok(field(visible, 'leads', 'source').options!.includes('Trade Fair'));
  assert.equal(visible.dropdownOptions.some(row => row.moduleId === 'products'), false);
  assert.ok(visible.dropdownOptions.every(row => row.schemaOnly && !row.createdById && !row.createdAt && !row.description));
  const restricted: AccessUser = { userId: 'restricted', displayName: 'Restricted editor', role: 'Restricted editor' };
  assert.equal(visibleStore(store, restricted).dropdownOptions.some(row => row.moduleId === 'leads' && row.fieldKey === 'source'), false);
});

test('custom module and field metadata survive scoped refresh with settings permissions hidden', () => {
  const store = fixture();
  store.customModules = [{ id: 'custom-assets', moduleId: 'equipmentAudits', name: 'Equipment Audits', singular: 'Audit', group: 'Operations', statuses: 'Open\nClosed', permissions: 'admin-only-secret', status: 'Active' }];
  store.customFields = [{ id: 'custom-check', moduleId: 'equipmentAudits', key: 'condition', name: 'Condition', type: 'radio', options: 'Good\nRepair', formula: 'private accounting', status: 'Active' }];
  store.equipmentAudits = [];
  store.roles.push({ id: 'audit-role', name: 'Auditor', allowedModules: 'equipmentAudits', permissions: ['View', 'Edit'], status: 'Active' });
  const user: AccessUser = { userId: 'auditor', displayName: 'Auditor', role: 'Auditor' };
  const created = add(store, 'equipmentAudits', 'condition', 'Replace', user);
  const visible = visibleStore(created.store, user);
  assert.equal(permit(user.role, 'customModules', 'view', created.store), false);
  assert.equal(visible.customModules[0].permissions, undefined);
  assert.equal(visible.customFields[0].formula, undefined);
  assert.ok(field(visible, 'equipmentAudits', 'condition').options!.includes('Replace'));
});

test('inactive and deleted option definitions are excluded from current choices', () => {
  let store = add(fixture(), 'contacts', 'type', 'Procurement').store;
  const option = store.dropdownOptions[0];
  store = applyMutation(store, 'dropdownOptions', 'update', { status: 'Inactive' }, option.id).store;
  assert.equal(field(store, 'contacts', 'type').options!.includes('Procurement'), false);
  store = add(store, 'contacts', 'type', 'Procurement').store;
  assert.equal(store.dropdownOptions.length, 2);
  const newest = store.dropdownOptions.find(row => row.status === 'Active')!;
  store = applyMutation(store, 'dropdownOptions', 'delete', {}, newest.id).store;
  assert.equal(field(store, 'contacts', 'type').options!.includes('Procurement'), false);
});

test('direct configurable-list writes enforce scope-aware normalized uniqueness', () => {
  const first = add(fixture(), 'contacts', 'type', 'Procurement').store;
  assert.throws(() => applyMutation(first, 'dropdownOptions', 'create', { name: ' procurement ', moduleId: 'contacts', fieldKey: 'type', status: 'Active' }), /already exists/);
  const category = add(first, 'customers', 'city', 'Zirakpur').store;
  assert.throws(() => applyMutation(category, 'categories', 'create', { name: ' ZIRAKPUR ', type: 'City', status: 'Active' }), /already exists/);
  assert.doesNotThrow(() => applyMutation(category, 'categories', 'create', { name: 'Zirakpur', type: 'Location', status: 'Active' }));
});
