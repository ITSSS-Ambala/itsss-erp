import { resolveModules, type ERPRecord, type Store } from './schema.ts';
import { recalculate } from './engine.ts';

export const DEMO_CONTENT_VERSION = 2;
const standardRoles = ['Super Admin', 'Admin', 'Manager', 'Sales', 'Technician', 'Developer', 'Marketing', 'Accounts', 'Inventory', 'Viewer', 'Client'];
const preferredExamples: Record<string, string> = { employees: 'EMP-004', users: 'USER-002', taxes: 'TAX-004' };
type Reference = { moduleId: string; key: string };

/** Relations include custom fields and the record links used by history/configuration. */
function references(store: Store, moduleId: string, record: ERPRecord): Reference[] {
  // History describes past records; it must not keep those samples alive or be rewritten.
  if (['auditLogs', 'activities'].includes(moduleId)) return [];
  const fields = resolveModules(store).find(module => module.id === moduleId)?.fields || [];
  const result = fields.filter(field => field.relation).map(field => ({ moduleId: field.relation!, key: field.key }));
  if (moduleId === 'customers') result.push({ moduleId: 'leads', key: 'profileLeadId' });
  if (moduleId !== 'notifications') for (const [moduleKey, recordKey] of [['relatedModule', 'relatedId'], ['sourceModule', 'sourceId'], ['module', 'recordId']]) {
    if (typeof record[moduleKey] === 'string') result.push({ moduleId: record[moduleKey], key: recordKey });
  }
  return result;
}

/** Keep one example per populated module and detach real records from surplus samples. */
export function reduceDemoContent(store: Store, protectedUserIds: readonly string[] = []): { removed: number; clearedLinks: number } {
  // These are functional access definitions, rather than sample business records.
  for (const [index, name] of standardRoles.entries()) {
    const role = (store.roles || []).find(row => row.id === `ROLE-${String(index + 1).padStart(3, '0')}` && row.name === name);
    if (role?.demo === true) { delete role.demo; role.systemDefault = true; }
  }

  // An account with configured credentials is an operational account, even if
  // it originally came from a sample. Never delete its password or membership.
  for (const member of store.users || []) if (protectedUserIds.includes(member.id)) delete member.demo;
  for (const definition of store.customModules || []) {
    if ((store[definition.moduleId] || []).some(row => row.demo !== true)) delete definition.demo;
  }
  for (const field of store.customFields || []) {
    if ((store[field.moduleId] || []).some(row => row.demo !== true && row[field.key] !== undefined)) delete field.demo;
  }

  // Prefer an example already used by real business data, without preserving
  // every sample reached through audit history or through another sample.
  const usage = new Map<string, Map<string, number>>();
  const recordReferences = new Map<ERPRecord, Reference[]>();
  for (const [moduleId, rows] of Object.entries(store)) for (const record of rows) {
    const links = references(store, moduleId, record);
    recordReferences.set(record, links);
    if (record.demo === true || moduleId === 'notifications') continue;
    for (const reference of links) {
      const scores = usage.get(reference.moduleId) || new Map<string, number>();
      const value = record[reference.key];
      for (const id of Array.isArray(value) ? value : [value]) if (typeof id === 'string') scores.set(id, (scores.get(id) || 0) + 1);
      usage.set(reference.moduleId, scores);
    }
  }

  const kept = new Map<string, string>();

  const modulesBySelection = Object.entries(store).sort(([left], [right]) => (left === 'customers' ? -1 : right === 'customers' ? 1 : 0));
  for (const [moduleId, rows] of modulesBySelection) {
    const demos = rows.filter(row => row.demo === true);
    if (!demos.length) continue;
    const active = demos.filter(row => !row.deletedAt && !row.archivedAt);
    const candidates = active.length ? active : demos;
    const company = moduleId === 'leads' ? store.customers?.find(row => row.id === kept.get('customers')) : undefined;
    const companyProfile = company && candidates.find(row => row.id === company.profileLeadId || row.customer === company.id);
    const scores = usage.get(moduleId);
    const bestScore = Math.max(...candidates.map(row => scores?.get(row.id) || 0));
    const mostUsed = candidates.filter(row => (scores?.get(row.id) || 0) === bestScore);
    const example = companyProfile || mostUsed.find(row => row.id === preferredExamples[moduleId]) || mostUsed[0];
    kept.set(moduleId, example.id);
  }

  const removed = new Map<string, Set<string>>();
  const examples = new Map<string, ERPRecord>();
  for (const [moduleId, rows] of Object.entries(store)) {
    const retained = rows.filter(row => row.demo !== true || kept.get(moduleId) === row.id);
    removed.set(moduleId, new Set(rows.filter(row => !retained.includes(row)).map(row => row.id)));
    store[moduleId] = retained;
    const example = retained.find(row => row.demo === true && !row.deletedAt && !row.archivedAt) || retained.find(row => row.demo === true);
    if (example) examples.set(moduleId, example);
  }
  // Only the remaining samples get relinked. Real records are never silently
  // reassigned to another sample company, employee, product or project.
  let clearedLinks = 0;
  for (const rows of Object.values(store)) {
    for (const record of rows) {
      for (const reference of recordReferences.get(record) || []) {
        const replacement = examples.get(reference.moduleId)?.id;
        const remap = (value: unknown) => {
          if (typeof value !== 'string' || !removed.get(reference.moduleId)?.has(value)) return value;
          if (record.demo === true) return replacement || '';
          clearedLinks++;
          return '';
        };
        const value = record[reference.key];
        if (Array.isArray(value)) record[reference.key] = [...new Set(value.map(remap).filter(Boolean))];
        else if (value !== undefined) record[reference.key] = remap(value);
      }
    }
  }
  recalculate(store);
  return {
    removed: [...removed.values()].reduce((total, ids) => total + ids.size, 0),
    clearedLinks,
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
