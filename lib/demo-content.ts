import { resolveModules, type ERPRecord, type Store } from './schema.ts';
import { recalculate } from './engine.ts';

export const DEMO_CONTENT_VERSION = 1;
const standardRoles = ['Super Admin', 'Admin', 'Manager', 'Sales', 'Technician', 'Developer', 'Marketing', 'Accounts', 'Inventory', 'Viewer', 'Client'];
const preferredExamples: Record<string, string> = { employees: 'EMP-004', users: 'USER-002', taxes: 'TAX-004' };
type Reference = { moduleId: string; key: string };

/** Relations include custom fields and the record links used by history/configuration. */
function references(store: Store, moduleId: string, record: ERPRecord): Reference[] {
  const fields = resolveModules(store).find(module => module.id === moduleId)?.fields || [];
  const result = fields.filter(field => field.relation).map(field => ({ moduleId: field.relation!, key: field.key }));
  if (moduleId === 'customers') result.push({ moduleId: 'leads', key: 'profileLeadId' });
  for (const [moduleKey, recordKey] of [['relatedModule', 'relatedId'], ['sourceModule', 'sourceId'], ['module', 'recordId']]) {
    if (typeof record[moduleKey] === 'string') result.push({ moduleId: record[moduleKey], key: recordKey });
  }
  return result;
}

/** Keep one example per populated module without rewriting real records or their dependencies. */
export function reduceDemoContent(store: Store, protectedUserIds: readonly string[] = []): { removed: number; linkedExamples: number } {
  // These are functional access definitions, rather than sample business records.
  for (const [index, name] of standardRoles.entries()) {
    const role = (store.roles || []).find(row => row.id === `ROLE-${String(index + 1).padStart(3, '0')}` && row.name === name);
    if (role?.demo === true) { delete role.demo; role.systemDefault = true; }
  }

  const kept = new Map<string, Set<string>>();
  const protectedExamples = new Map<string, Set<string>>();
  const pending: { moduleId: string; record: ERPRecord }[] = [];
  const protect = (moduleId: string, record: ERPRecord) => {
    const ids = kept.get(moduleId) || new Set<string>();
    if (ids.has(record.id)) return;
    ids.add(record.id); kept.set(moduleId, ids); pending.push({ moduleId, record });
    if (record.demo === true) {
      const linked = protectedExamples.get(moduleId) || new Set<string>();
      linked.add(record.id); protectedExamples.set(moduleId, linked);
    }
  };
  for (const [moduleId, rows] of Object.entries(store)) {
    for (const record of rows) if (record.demo !== true || moduleId === 'settings') protect(moduleId, record);
  }
  for (const member of store.users || []) if (protectedUserIds.includes(member.id)) protect('users', member);
  // A real record may depend on an entire linked sample chain. Retain that chain.
  for (let index = 0; index < pending.length; index++) {
    const { moduleId, record } = pending[index];
    for (const reference of references(store, moduleId, record)) {
      const value = record[reference.key], ids = Array.isArray(value) ? value : [value];
      for (const id of ids) {
        const target = store[reference.moduleId]?.find(row => row.id === id);
        if (target) protect(reference.moduleId, target);
      }
    }
    // Real rows/configuration in a custom module also need its module definition.
    const custom = store.customModules?.find(row => row.moduleId === moduleId || row.moduleId === record.moduleId);
    if (custom) protect('customModules', custom);
  }

  const modulesBySelection = Object.entries(store).sort(([left], [right]) => (left === 'customers' ? -1 : right === 'customers' ? 1 : 0));
  for (const [moduleId, rows] of modulesBySelection) {
    const demos = rows.filter(row => row.demo === true);
    if (!demos.length || demos.some(row => kept.get(moduleId)?.has(row.id))) continue;
    const active = demos.filter(row => !row.deletedAt && !row.archivedAt);
    const candidates = active.length ? active : demos;
    const company = moduleId === 'leads' ? store.customers?.find(row => row.demo === true && kept.get('customers')?.has(row.id)) : undefined;
    const companyProfile = company && candidates.find(row => row.id === company.profileLeadId || row.customer === company.id);
    const example = companyProfile || candidates.find(row => row.id === preferredExamples[moduleId]) || candidates[0];
    const ids = kept.get(moduleId) || new Set<string>();
    ids.add(example.id); kept.set(moduleId, ids);
  }

  const removed = new Map<string, Set<string>>();
  const examples = new Map<string, ERPRecord>();
  for (const [moduleId, rows] of Object.entries(store)) {
    const retained = rows.filter(row => row.demo !== true || kept.get(moduleId)?.has(row.id));
    removed.set(moduleId, new Set(rows.filter(row => !retained.includes(row)).map(row => row.id)));
    store[moduleId] = retained;
    const example = retained.find(row => row.demo === true && !row.deletedAt && !row.archivedAt) || retained.find(row => row.demo === true);
    if (example) examples.set(moduleId, example);
  }
  // Only samples get relinked. Real records and protected samples retain their original links.
  for (const [moduleId, rows] of Object.entries(store)) {
    for (const record of rows) {
      if (record.demo !== true || protectedExamples.get(moduleId)?.has(record.id)) continue;
      for (const reference of references(store, moduleId, record)) {
        const replacement = examples.get(reference.moduleId)?.id;
        if (!replacement) continue;
        const remap = (value: unknown) => typeof value === 'string' && removed.get(reference.moduleId)?.has(value) ? replacement : value;
        const value = record[reference.key];
        record[reference.key] = Array.isArray(value) ? [...new Set(value.map(remap))] : remap(value);
      }
    }
  }
  recalculate(store);
  return {
    removed: [...removed.values()].reduce((total, ids) => total + ids.size, 0),
    linkedExamples: [...protectedExamples.values()].reduce((total, ids) => total + ids.size, 0),
  };
}

/** Version the cleanup so edits, duplicates, removals and future imports are not repeatedly pruned. */
export function migrateDemoContent(store: Store, protectedUserIds: readonly string[] = []): boolean {
  const settings = store.settings?.[0];
  if (!settings || Number(settings.demoContentVersion || 0) >= DEMO_CONTENT_VERSION) return false;
  reduceDemoContent(store, protectedUserIds);
  settings.demoContentVersion = DEMO_CONTENT_VERSION;
  return true;
}
