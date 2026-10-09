import { getDropdownConfig, moduleById, resolveModules, type ERPRecord, type Field, type Store } from './schema.ts';
import { validateRecord, recalculate } from './engine.ts';
import { validateLogoMetadata } from './media.ts';

export type AccessUser = { userId: string; displayName: string; email?: string; memberId?: string; role: string; employee?: string; customer?: string };
const live = (rows: ERPRecord[] = []) => rows.filter(row => !row.deletedAt && !row.archivedAt && row.status !== 'Inactive');
const configured = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
export const historyModules = new Set(['auditLogs', 'activities', 'stockHistory']);
const adminModules = new Set(['users', 'roles', 'customFields', 'customModules', 'customStatuses', 'customForms', 'dropdownOptions', 'categories', 'taxes', 'templates', 'automations', 'vault', 'backups']);
const restrictedRoles = new Set(['Technician', 'Developer', 'Marketing', 'Sales', 'Client']);
const financialFields = new Set(['purchasePrice', 'unitCost', 'salary', 'cost', 'actualCost', 'estimatedCost', 'profit', 'margin', 'materialCost', 'expectedProfit', 'costVariance', 'creditLimit', 'licenseKey', 'credential', 'commission', 'totalCost', 'lifetimeProfit', 'netSalary']);
const writable: Record<string, string[]> = {
  Sales: ['leads', 'followups', 'customers', 'contacts', 'opportunities', 'projects', 'events', 'documents', 'notes', 'savedViews'],
  Technician: ['technicianJobs', 'tasks', 'surveys', 'workOrders', 'tickets', 'remoteSupport', 'assets', 'cctv', 'networks', 'notes', 'documents', 'attendance'],
  Accounts: ['payments', 'expenses', 'income', 'receivables', 'payables', 'payroll', 'commissions', 'purchases', 'supplierPayments', 'employeeExpenses'],
  Inventory: ['inventory', 'stockTransfers', 'allocations', 'products', 'serials', 'suppliers', 'purchaseRequests', 'purchases', 'purchaseOrders'],
  Developer: ['websites', 'tasks', 'tickets', 'notes', 'documents', 'events'],
  Marketing: ['socialAccounts', 'content', 'campaigns', 'leads', 'notes', 'documents', 'events'],
};
const fallbackRead: Record<string, string[]> = {
  Sales: [...writable.Sales, 'sites', 'products', 'services', 'employees'],
  Technician: [...writable.Technician, 'projects', 'sites', 'customers', 'contacts', 'products', 'services', 'employees', 'allocations', 'events'],
  Accounts: [...writable.Accounts, 'projects', 'customers', 'employees', 'suppliers', 'products', 'services', 'documents'],
  Inventory: [...writable.Inventory, 'projects', 'employees', 'stockHistory'],
  Developer: [...writable.Developer, 'projects', 'customers', 'sites', 'domains', 'hosting', 'employees'],
  Marketing: [...writable.Marketing, 'projects', 'customers', 'employees'],
  Client: ['customers', 'projects', 'payments', 'tickets', 'assets', 'amc', 'licenses', 'documents', 'sites', 'contacts'],
};

export function resolveRole(role: unknown, store: Store): string {
  const record = live(store.roles).find(row => row.id === role || row.name === role);
  if (record) return String(record.name);
  if ((store.roles || []).some(row => row.id === role || row.name === role)) return 'Unassigned';
  return ['Super Admin', 'Admin', 'Manager', 'Sales', 'Technician', 'Developer', 'Marketing', 'Accounts', 'Inventory', 'Viewer', 'Client'].includes(String(role)) ? String(role) : 'Unassigned';
}

export function permit(roleValue: string, moduleId: string, actionValue: string, store: Store): boolean {
  const role = resolveRole(roleValue, store);
  const aliases: Record<string, string> = { create: 'add', update: 'edit', duplicate: 'add', import: 'add', restore: 'delete', archive: 'edit', permanentDelete: 'delete' };
  const action = aliases[actionValue] || actionValue.toLowerCase();
  if (!['view', 'add', 'edit', 'delete', 'export', 'approve', 'assign', 'download', 'share'].includes(action)) return false;
  if (!moduleById[moduleId] && !live(store.customModules).some(module => module.moduleId === moduleId)) return false;
  if (historyModules.has(moduleId) && !['view', 'export', 'download'].includes(action)) return false;
  if (['Super Admin', 'Admin'].includes(role)) return true;
  if (role === 'Unassigned') return false;
  if (moduleId === 'projectPosts') {
    if (!permit(roleValue, 'projects', 'view', store)) return false;
    if (['view', 'download', 'export'].includes(action)) return action === 'view' || permit(roleValue, 'projects', action, store);
    if (!['add', 'edit', 'delete'].includes(action) || role === 'Viewer') return false;
    return ['Manager', 'Sales', 'Technician', 'Developer', 'Marketing', 'Accounts', 'Inventory', 'Client'].includes(role) || permit(roleValue, 'projects', 'add', store) || permit(roleValue, 'projects', 'edit', store);
  }
  if (adminModules.has(moduleId) || moduleId === 'auditLogs') return false;
  if (moduleId === 'settings') return action === 'view';
  if (['Viewer', 'Client'].includes(role) && !['view', 'download', 'export'].includes(action)) return false;
  if (['Sales', 'Technician', 'Developer', 'Marketing'].includes(role) && ['expenses', 'income', 'payments', 'receivables', 'payables', 'purchases', 'supplierPayments', 'payroll', 'commissions', 'employeeExpenses'].includes(moduleId)) return false;
  const definition = live(store.roles).find(row => row.name === role);
  if (definition) {
    const allowed = configured(definition.allowedModules);
    if (!allowed.includes('*') && !allowed.includes(moduleId)) return false;
    let permissions: unknown = definition.permissions;
    if (typeof permissions === 'string') {
      try { permissions = JSON.parse(permissions); } catch { permissions = configured(permissions); }
    }
    if (Array.isArray(permissions)) {
      const list = permissions.map(item => String(item).toLowerCase());
      if (!list.includes(action) && !list.includes(`${moduleId.toLowerCase()}:${action}`)) return false;
    } else if (permissions && typeof permissions === 'object') {
      const map = permissions as Record<string, unknown>;
      if (!configured(map[moduleId]).map(item => item.toLowerCase()).includes(action)) return false;
    } else return false;
  } else if (action === 'view' || action === 'download' || action === 'export') {
    if (!['Manager', 'Viewer'].includes(role) && !(fallbackRead[role] || []).includes(moduleId)) return false;
  }
  if (['view', 'download', 'export'].includes(action)) return true;
  if (action === 'approve') return ['Manager', 'Accounts'].includes(role) || !writable[role];
  if (role === 'Manager') return true;
  return writable[role] ? writable[role].includes(moduleId) : Boolean(definition);
}

function technicianScope(store: Store, employee: string) {
  const assigned = (row: ERPRecord) => row.technician === employee || row.assignedTo === employee || row.employee === employee;
  const work = ['technicianJobs', 'workOrders', 'tasks', 'surveys', 'tickets', 'remoteSupport', 'allocations'].flatMap(moduleId => live(store[moduleId]).filter(assigned));
  const assignedSites = new Set(live(store.sites).filter(assigned).map(row => row.id));
  const projects = new Set([...work.map(row => row.project), ...live(store.projects).filter(row => Array.isArray(row.technicians) && row.technicians.includes(employee) || assignedSites.has(row.site)).map(row => row.id)].filter(Boolean));
  const sites = new Set([...work.map(row => row.site), ...live(store.sites).filter(assigned).map(row => row.id), ...live(store.projects).filter(row => projects.has(row.id)).map(row => row.site)].filter(Boolean));
  const customers = new Set([...work.map(row => row.customer), ...live(store.sites).filter(row => sites.has(row.id)).map(row => row.customer), ...live(store.projects).filter(row => projects.has(row.id)).map(row => row.customer)].filter(Boolean));
  return { assigned, projects, sites, customers };
}

export function canViewRecord(store: Store, user: AccessUser, moduleId: string, row: ERPRecord, depth = 0): boolean {
  if (depth > 4 || !permit(user.role, moduleId, 'view', store)) return false;
  if (['Super Admin', 'Admin'].includes(user.role)) return true;
  if (moduleId === 'settings') return true;
  if (moduleId === 'projectPosts') {
    if (row.deletedAt && row.authorId !== user.userId) return false;
    let parentId = row.parent;
    const seen = new Set<string>([row.id]);
    while (parentId) {
      const parent = (store.projectPosts || []).find(post => post.id === parentId);
      if (!parent || parent.deletedAt || parent.archivedAt || parent.project !== row.project || seen.has(parent.id)) return false;
      seen.add(parent.id); parentId = parent.parent;
    }
    const linked = (store.projects || []).find(project => project.id === row.project && !project.deletedAt);
    return Boolean(linked && canViewRecord(store, user, 'projects', linked, depth + 1));
  }
  const owns = row.createdById === user.userId || row.author === user.userId || Boolean(user.employee && row.author === user.employee);
  if (moduleId === 'notes' && row.type === 'Private' && !owns) return false;
  if (moduleId === 'savedViews' && !row.shared && row.createdById !== user.userId && !(user.employee && row.employee === user.employee)) return false;
  if (['documents', 'notes'].includes(moduleId) && row.relatedModule && row.relatedId) {
    const linked = (store[row.relatedModule] || []).find(item => item.id === row.relatedId && !item.deletedAt);
    return Boolean(linked && canViewRecord(store, user, row.relatedModule, linked, depth + 1));
  }
  if (user.role === 'Client') {
    if (!user.customer || !live(store.customers).some(customer => customer.id === user.customer)) return false;
    if (moduleId === 'customers') return row.id === user.customer;
    if (row.customer) return row.customer === user.customer;
    if (row.project) return live(store.projects).some(project => project.id === row.project && project.customer === user.customer);
    if (row.site) return live(store.sites).some(site => site.id === row.site && site.customer === user.customer);
    return false;
  }
  if (user.role === 'Technician') {
    if (!user.employee || !live(store.employees).some(employee => employee.id === user.employee)) return false;
    const scope = technicianScope(store, user.employee);
    if (moduleId === 'employees') return row.id === user.employee;
    if (['products', 'services'].includes(moduleId)) return true;
    if (moduleId === 'customers') return scope.customers.has(row.id);
    if (moduleId === 'contacts') return scope.customers.has(row.customer) || scope.sites.has(row.site);
    if (moduleId === 'sites') return scope.sites.has(row.id);
    if (moduleId === 'projects') return scope.projects.has(row.id);
    if (['technicianJobs', 'workOrders', 'tasks', 'tickets', 'surveys', 'remoteSupport', 'attendance'].includes(moduleId)) return scope.assigned(row);
    if (['assets', 'cctv', 'networks', 'allocations', 'events'].includes(moduleId)) return scope.assigned(row) || scope.sites.has(row.site) || scope.projects.has(row.project);
    if (['documents', 'notes', 'savedViews'].includes(moduleId)) return row.createdById === user.userId || scope.assigned(row) || scope.customers.has(row.customer) || scope.sites.has(row.site) || scope.projects.has(row.project);
    return false;
  }
  return true;
}

export function hiddenFields(store: Store, user: AccessUser, moduleId: string): Set<string> {
  const fields = new Set<string>();
  if (restrictedRoles.has(user.role)) for (const key of financialFields) fields.add(key);
  if (['Technician', 'Developer', 'Marketing'].includes(user.role)) for (const key of ['value', 'paidAmount', 'balanceDue', 'paymentStatus', 'totalRevenue']) fields.add(key);
  const role = live(store.roles).find(row => row.name === user.role || row.id === user.role);
  for (const token of configured(role?.hiddenFields)) {
    const dot = token.indexOf('.');
    if (dot < 0) fields.add(token);
    else if (token.slice(0, dot) === moduleId || token.slice(0, dot) === '*') fields.add(token.slice(dot + 1));
  }
  return fields;
}

export type ProjectCapabilities = { post: boolean; updateProgress: boolean; managePosts: boolean };
export function projectCapabilities(store: Store, user: AccessUser, projectId: string): ProjectCapabilities {
  const project = (store.projects || []).find(row => row.id === projectId && !row.deletedAt && !row.archivedAt);
  if (!project || !canViewRecord(store, user, 'projects', project)) return { post: false, updateProgress: false, managePosts: false };
  const admin = ['Super Admin', 'Admin'].includes(user.role), masks = hiddenFields(store, user, 'projects');
  const post = permit(user.role, 'projectPosts', 'add', store) && !hiddenFields(store, user, 'projectPosts').has('body');
  return { post, updateProgress: post && !masks.has('progress') && !masks.has('status') && (admin || user.role === 'Technician' || permit(user.role, 'projects', 'edit', store)), managePosts: admin };
}

export function projectCapabilitiesFor(store: Store, user: AccessUser): Record<string, ProjectCapabilities> {
  return Object.fromEntries((store.projects || []).filter(row => !row.deletedAt && canViewRecord(store, user, 'projects', row)).map(row => [row.id, projectCapabilities(store, user, row.id)]));
}

export function canCreateDropdownOption(store: Store, user: AccessUser, moduleId: string, field: Field): boolean {
  if (!permit(user.role, moduleId, 'view', store) || !(permit(user.role, moduleId, 'add', store) || permit(user.role, moduleId, 'edit', store)) || hiddenFields(store, user, moduleId).has(field.key)) return false;
  if (user.role === 'Technician' && (!user.employee || !live(store.employees).some(row => row.id === user.employee))) return false;
  // Employee roles are real authorization definitions, not arbitrary new strings.
  if (moduleId === 'employees' && field.key === 'role') return permit(user.role, 'roles', 'view', store) && permit(user.role, 'roles', 'add', store);
  const config = getDropdownConfig(moduleId, field);
  if (!config) return false;
  if (config.kind === 'relation') return Boolean(config.targetModule && permit(user.role, config.targetModule, 'view', store) && permit(user.role, config.targetModule, 'add', store));
  return true;
}

export function dropdownPermissionsFor(store: Store, user: AccessUser): Record<string, Record<string, boolean>> {
  return Object.fromEntries(resolveModules(store).map(module => [module.id, Object.fromEntries(module.fields.map(field => [field.key, canCreateDropdownOption(store, user, module.id, field)]))]));
}

export function visibleStore(store: Store, user: AccessUser): Store {
  const result: Store = {};
  for (const [moduleId, rows] of Object.entries(store)) {
    if (!permit(user.role, moduleId, 'view', store)) continue;
    const hidden = hiddenFields(store, user, moduleId);
    result[moduleId] = rows.filter(row => canViewRecord(store, user, moduleId, row)).map(row => {
      const safe = { ...row };
      for (const key of hidden) delete safe[key];
      if (!['Super Admin', 'Admin'].includes(user.role)) for (const key of ['ip', 'device', 'oldValue', 'newValue', 'actorId', 'lastLogin']) delete safe[key];
      if (moduleId === 'settings' && !['Super Admin', 'Admin'].includes(user.role)) return Object.fromEntries(Object.entries(safe).filter(([key]) => ['id', 'name', 'fullName', 'logo', 'brandColor', 'currency', 'demo', 'passwordMinLength'].includes(key))) as ERPRecord;
      return safe;
    });
  }
  if (!['Super Admin', 'Admin'].includes(user.role)) {
    // These are read-only, scoped schema choices, not access to settings records.
    const definitions = resolveModules(store).filter(module => permit(user.role, module.id, 'view', store));
    result.dropdownOptions = definitions.flatMap(module => module.fields.filter(field => !hiddenFields(store, user, module.id).has(field.key)).flatMap(field => (field.options || []).map((name, index) => ({ id: `SCHEMA-${module.id}-${field.key}-${index}`, moduleId: module.id, fieldKey: field.key, name, status: 'Active', schemaOnly: true }))));
    result.customModules = live(store.customModules).filter(row => permit(user.role, row.moduleId, 'view', store)).map(row => ({ id: row.id, name: row.name, moduleId: row.moduleId, singular: row.singular, group: row.group, description: row.description, statuses: hiddenFields(store, user, row.moduleId).has('status') ? '' : row.statuses, status: 'Active', schemaOnly: true }));
    result.customFields = live(store.customFields).filter(row => permit(user.role, row.moduleId, 'view', store) && !hiddenFields(store, user, row.moduleId).has(row.key)).map(row => ({ id: row.id, name: row.name, moduleId: row.moduleId, key: row.key, type: row.type, required: row.required, options: row.options, relation: row.relation, section: row.section, status: 'Active', schemaOnly: true }));
  }
  return result;
}

const approvalModules = new Set(['expenses', 'employeeExpenses', 'payroll', 'commissions', 'purchaseRequests', 'purchaseOrders', 'purchases', 'stockTransfers', 'allocations']);
const approved = (row: Partial<ERPRecord>) => row.approvalStatus === 'Approved' || ['Approved', 'Paid', 'Reimbursed', 'Ordered', 'Received', 'Completed', 'Issued', 'Used', 'Returned'].includes(String(row.status));
export function assertMutationAccess(store: Store, user: AccessUser, moduleId: string, action: string, data: Partial<ERPRecord>, existing?: ERPRecord) {
  if (moduleId === 'projectPosts') {
    const target = { ...existing, ...data }, capabilities = projectCapabilities(store, user, String(target.project || ''));
    if (!capabilities.post || existing && !canViewRecord(store, user, moduleId, existing)) throw new Error('FORBIDDEN: You cannot post in this project.');
    if (!['create', 'update', 'delete', 'restore', 'permanentDelete'].includes(action)) throw new Error('Unsupported project post action.');
    if (existing && !capabilities.managePosts && existing.authorId !== user.userId) throw new Error('FORBIDDEN: Only the author or an administrator can manage this post.');
    if (action === 'permanentDelete' && !capabilities.managePosts) throw new Error('FORBIDDEN: Administrator permission is required.');
    for (const key of ['authorId', 'authorName', 'authorRole', 'postedAt', 'authorEmployee']) if (Object.prototype.hasOwnProperty.call(data, key)) throw new Error('FORBIDDEN: Post authorship is assigned by the server.');
    if (existing) for (const key of ['project', 'parent', 'kind', 'progress', 'stage']) if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== existing[key]) throw new Error('The project, reply thread and historical progress of a post cannot be changed.');
    if (action === 'create' && (target.kind === 'Update' || data.progress !== undefined || data.stage) && !capabilities.updateProgress) throw new Error('FORBIDDEN: You can comment but cannot update project progress.');
    if (Object.prototype.hasOwnProperty.call(data, 'pinned') && data.pinned !== existing?.pinned && !capabilities.managePosts && !(action === 'create' && data.pinned === false)) throw new Error('FORBIDDEN: Only administrators can pin project posts.');
    for (const key of hiddenFields(store, user, moduleId)) if (Object.prototype.hasOwnProperty.call(data, key)) throw new Error('FORBIDDEN: You cannot change a restricted field.');
    return;
  }
  if (!permit(user.role, moduleId, 'view', store) || !permit(user.role, moduleId, action, store)) throw new Error('FORBIDDEN: Your role cannot make this change.');
  if (existing && !canViewRecord(store, user, moduleId, existing)) throw new Error('FORBIDDEN: This record is outside your assigned scope.');
  const target = { ...existing, ...data, id: existing?.id || 'new', createdById: existing?.createdById || user.userId } as ERPRecord;
  if (user.role === 'Technician') {
    if (!canViewRecord(store, user, moduleId, target)) throw new Error('FORBIDDEN: This record is assigned to another employee.');
    for (const key of ['technician', 'assignedTo', 'employee']) if (data[key] && data[key] !== user.employee) throw new Error('FORBIDDEN: You cannot assign work to another employee.');
    for (const [key, related] of [['customer', 'customers'], ['site', 'sites'], ['project', 'projects']]) if (data[key] && data[key] !== existing?.[key]) {
      const linked = (store[related] || []).find(row => row.id === data[key]);
      if (!linked || !canViewRecord(store, user, related, linked)) throw new Error('FORBIDDEN: The selected record is outside your assigned scope.');
    }
  }
  const financialKeys = ['status', 'approvalStatus', 'amount', 'quantity', 'usedQuantity', 'returnedQuantity', 'wastage', 'rate', 'salary', 'bonus', 'incentives', 'deductions', 'advances', 'reimbursements', 'percentage', 'fixedAmount', 'customer', 'project', 'product', 'location', 'fromLocation', 'toLocation'];
  const changesApprovedValue = Object.keys(data).some(key => financialKeys.includes(key) && data[key] !== existing?.[key]);
  const changesApprovedLifecycle = ['delete', 'restore', 'permanentDelete'].includes(action);
  if (approvalModules.has(moduleId) && (approved(target) || existing && approved(existing)) && (!existing || !approved(existing) || changesApprovedValue || changesApprovedLifecycle) && !permit(user.role, moduleId, 'approve', store)) throw new Error('FORBIDDEN: Approval permission is required.');
  for (const key of hiddenFields(store, user, moduleId)) if (Object.prototype.hasOwnProperty.call(data, key) && (!existing || data[key] !== existing[key])) throw new Error('FORBIDDEN: You cannot change a restricted field.');
  if (!['Super Admin', 'Admin'].includes(user.role) && moduleId === 'notes' && target.type === 'Private' && existing && existing.createdById !== user.userId && !(user.employee && existing.author === user.employee)) throw new Error('FORBIDDEN: This note is private.');
}

function containsFile(value: unknown, key: string): boolean {
  return Array.isArray(value) && value.some(item => item && typeof item === 'object' && !Array.isArray(item) && item.key === key);
}
export function canDownloadFile(store: Store, user: AccessUser, key: string, metadata: Record<string, string> = {}): boolean {
  const moduleId = metadata.module || 'documents';
  const definitions = resolveModules(store);
  const recordHasFile = (id: string, row: ERPRecord, respectMasks = false) => definitions.find(module => module.id === id)?.fields.some(field => ['file', 'image'].includes(field.type) && (!respectMasks || !hiddenFields(store, user, id).has(field.key)) && containsFile(row[field.key], key));
  const visibleFile = (id: string, row: ERPRecord) => {
    return recordHasFile(id, row, true) && canViewRecord(store, user, id, row);
  };
  // Branding is shared only while the image is the currently linked company logo.
  if (permit(user.role, 'settings', 'view', store) && !hiddenFields(store, user, 'settings').has('logo')) {
    const logo = live(store.settings).flatMap(row => Array.isArray(row.logo) ? row.logo : []).find(file => file?.key === key);
    if (logo) try { validateLogoMetadata({ size: Number(metadata.size ?? logo.size), httpMetadata: { contentType: metadata.contentType || logo.type } }); return true; } catch { /* Unsafe legacy logos do not become shared files. */ }
  }
  if (user.role === 'Technician' && !user.employee || user.role === 'Client' && !user.customer) return false;
  if (moduleId === 'projectPosts') {
    if (!permit(user.role, 'projects', 'view', store)) return false;
    if (['Super Admin', 'Admin'].includes(user.role)) return true;
    const project = (store.projects || []).find(row => row.id === metadata.projectId && !row.deletedAt);
    if (!project || !canViewRecord(store, user, 'projects', project) || hiddenFields(store, user, 'projectPosts').has('media')) return false;
    const references = (store.projectPosts || []).filter(row => containsFile(row.media, key));
    if (references.length) return references.some(row => !row.deletedAt && !row.archivedAt && visibleFile('projectPosts', row));
    const age = Date.now() - new Date(metadata.uploadedAt || '').getTime();
    return metadata.creatorId === user.userId && age >= 0 && age <= 86400000 && projectCapabilities(store, user, project.id).post;
  }
  if (!permit(user.role, moduleId, 'download', store) || !permit(user.role, moduleId, 'view', store)) return false;
  if (['Super Admin', 'Admin'].includes(user.role)) return true;
  if (metadata.recordId) {
    const row = (store[moduleId] || []).find(record => record.id === metadata.recordId && !record.deletedAt);
    if (!row || !canViewRecord(store, user, moduleId, row)) return false;
    if (row && visibleFile(moduleId, row)) return true;
    if (recordHasFile(moduleId, row)) return false;
  }
  for (const [id, rows] of Object.entries(store)) if (rows.some(row => !row.deletedAt && visibleFile(id, row))) return true;
  if (Object.entries(store).some(([id, rows]) => rows.some(row => recordHasFile(id, row)))) return false;
  return metadata.creatorId === user.userId;
}

export function validatedRestore(snapshot: unknown, current: Store): Store {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || JSON.stringify(snapshot).length > 15 * 1024 * 1024) throw new Error('Choose a valid workspace backup up to 15 MB.');
  const restored = structuredClone(snapshot) as Store;
  if (Object.values(restored).some(value => !Array.isArray(value))) throw new Error('Backup modules must contain record arrays.');
  restored.users = structuredClone(current.users || []);
  restored.roles = structuredClone(current.roles || []);
  const validationStore = { ...restored, customModules: (restored.customModules || []).map(row => ({ ...row, deletedAt: undefined, status: 'Active' })) };
  const definitions = resolveModules(validationStore);
  const known = new Set(definitions.map(module => module.id));
  for (const [moduleId, rows] of Object.entries(restored)) {
    if (!known.has(moduleId)) throw new Error('Backup contains an unknown module: ' + moduleId);
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Backup has an invalid or duplicate record ID in ' + moduleId + '.');
      ids.add(row.id);
      if (row.deletedAt) continue;
      // Historical links to recycled records remain valid inside a complete snapshot.
      const historicalRelations = new Set((definitions.find(module => module.id === moduleId)?.fields || []).filter(field => field.relation && row[field.key]).filter(field => {
        const values = Array.isArray(row[field.key]) ? row[field.key] : [row[field.key]];
        return values.every((id: unknown) => (restored[field.relation!] || []).some(target => target.id === id));
      }).map(field => field.label + ' refers to a missing or deleted record.'));
      const errors = validateRecord(moduleId, row, validationStore).filter(error => !historicalRelations.has(error));
      if (errors.length) throw new Error('Backup validation failed for ' + moduleId + ' / ' + row.id + ': ' + errors.join(' '));
    }
  }
  restored.auditLogs = structuredClone(current.auditLogs || []);
  restored.activities = structuredClone(current.activities || []);
  return recalculate(restored);
}
