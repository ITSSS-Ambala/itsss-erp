import { createHash } from 'node:crypto';
import { getAlerts, recalculate, type Alert } from './engine.ts';
import { canViewRecord, notificationSourceVisible, resolveRole, type AccessUser } from './access.ts';
import { businessDate } from './business-time.ts';
import { moduleById, resolveModules, type ERPRecord, type Store } from './schema.ts';

const live = (row: ERPRecord) => !row.deletedAt && !row.archivedAt && row.status !== 'Inactive';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
type Delivery = { key: string; type: string; moduleId: string; record: ERPRecord; message: string; severity: Alert['severity']; kind: 'alert' | 'event'; occurredAt: string; actorMemberId?: string };

export function memberIdentity(member: ERPRecord, store: Store): AccessUser {
  const email = String(member.email || '').trim().toLowerCase();
  const employees = (store.employees || []).filter(row => live(row) && email && String(row.email || '').trim().toLowerCase() === email);
  return { userId: member.identityId || (email ? `hostinger:${createHash('sha256').update(email).digest('hex')}` : member.id), memberId: member.id, displayName: member.name, email: member.email, role: resolveRole(member.role, store), employee: member.employee || member.technician || (employees.length === 1 ? employees[0].id : undefined), customer: member.customer };
}

// Only authorization fields survive removal; never copy file, financial or vault values.
export function notificationScope(record: ERPRecord): ERPRecord {
  return Object.fromEntries(['id', 'name', 'type', 'createdById', 'authorId', 'author', 'assignedTo', 'technician', 'manager', 'salesperson', 'employee', 'reviewer', 'owner', 'technicians', 'customer', 'site', 'project', 'parent', 'relatedModule', 'relatedId', 'shared'].filter(key => record[key] !== undefined).map(key => [key, record[key]])) as ERPRecord;
}

function responsibleEmployees(store: Store, moduleId: string, record: ERPRecord): Set<string> {
  const ids = new Set<string>();
  const add = (row?: ERPRecord) => {
    if (!row) return;
    for (const field of ['assignedTo', 'technician', 'manager', 'salesperson', 'employee', 'reviewer', 'owner']) if (typeof row[field] === 'string') ids.add(row[field]);
    if (Array.isArray(row.technicians)) for (const id of row.technicians) ids.add(String(id));
  };
  add(record);
  const projectId = moduleId === 'projects' ? record.id : record.project;
  const project = (store.projects || []).find(row => row.id === projectId && live(row));
  add(project);
  add((store.sites || []).find(row => row.id === (record.site || project?.site) && live(row)));
  if (record.lead) add((store.leads || []).find(row => row.id === record.lead && live(row)));
  return ids;
}

function department(delivery: Delivery): { roles: string[]; broadcast: boolean } {
  if (/^Payment /.test(delivery.type) || delivery.type === 'Cost Overrun') return { roles: ['Accounts'], broadcast: true };
  if (delivery.type === 'Low Stock') return { roles: ['Inventory'], broadcast: true };
  if (['domains', 'hosting', 'websites'].includes(delivery.moduleId)) return { roles: ['Developer'], broadcast: false };
  if (['amc', 'licenses'].includes(delivery.moduleId)) return { roles: ['Sales', 'Accounts'], broadcast: false };
  if (delivery.moduleId === 'warranties') return { roles: ['Inventory'], broadcast: false };
  if (['leads', 'followups', 'opportunities'].includes(delivery.moduleId)) return { roles: ['Sales', 'Marketing'], broadcast: false };
  if (delivery.moduleId === 'tickets') return { roles: ['Technician'], broadcast: false };
  const group = moduleById[delivery.moduleId]?.group || '';
  return { roles: /Finance/.test(group) ? ['Accounts'] : /Inventory|Purchases|Products/.test(group) ? ['Inventory'] : [], broadcast: false };
}

function recipients(store: Store, delivery: Delivery): ERPRecord[] {
  const assigned = responsibleEmployees(store, delivery.moduleId, delivery.record), team = department(delivery);
  const employeeFor = (member: ERPRecord) => memberIdentity(member, store).employee;
  const eligible = (store.users || []).filter(member => live(member) && member.status === 'Active' && notificationSourceVisible(store, memberIdentity(member, store), delivery.moduleId, delivery.record.id, delivery.type, notificationScope(delivery.record)));
  const hasAssignedMember = eligible.some(member => { const employee = employeeFor(member); return Boolean(employee && assigned.has(employee)); });
  return eligible.filter(member => {
    const user = memberIdentity(member, store);
    if (['Super Admin', 'Admin', 'Manager'].includes(user.role)) return true;
    if (member.id === delivery.actorMemberId) return true;
    const employee = employeeFor(member);
    if (employee && assigned.has(employee)) return true;
    if (delivery.record.createdById === user.userId || delivery.record.authorId === user.userId) return true;
    if (user.role === 'Client') return true; // Source and field permissions already restrict client delivery.
    return team.roles.includes(user.role) && (team.broadcast || !hasAssignedMember);
  });
}

function mutationEvents(store: Store, previous: Store, now: Date, actorMemberId?: string): Delivery[] {
  const events: Delivery[] = [];
  const definitions = new Map(resolveModules(store).map(module => [module.id, module]));
  for (const [moduleId, rows] of Object.entries(store)) {
    if (['notifications', 'auditLogs', 'activities', 'stockHistory', 'backups'].includes(moduleId) || !definitions.has(moduleId)) continue;
    const oldRows = previous[moduleId] || [];
    for (const record of [...rows, ...oldRows.filter(row => !rows.some(current => current.id === row.id))]) {
      if (record.demo === true) continue;
      const before = (previous[moduleId] || []).find(row => row.id === record.id);
      const removed = !rows.some(row => row.id === record.id);
      let type = '', message = '';
      const assignments = ['assignedTo', 'technician', 'manager', 'salesperson', 'employee', 'technicians', 'reviewer', 'owner'];
      const assigned = assignments.some(field => JSON.stringify(record[field]) !== JSON.stringify(before?.[field]));
      if (removed) { type = 'Record Deleted'; message = 'Record permanently deleted.'; }
      else if (record.deletedAt && !before?.deletedAt) { type = 'Record Deleted'; message = 'Record moved to the recycle bin.'; }
      else if (record.archivedAt && !before?.archivedAt) { type = 'Record Archived'; message = 'Record archived.'; }
      else if (record.deletedAt || record.archivedAt) continue;
      else if (before?.deletedAt || before?.archivedAt) { type = 'Record Restored'; message = 'Record restored to the workspace.'; }
      else if (moduleId === 'leads' && !before) { type = 'New Lead'; message = `New lead created${record.status ? ` (${record.status})` : ''}.`; }
      else if (moduleId === 'leads' && assigned) { type = 'Lead Assigned'; message = 'Lead responsibility was assigned or changed.'; }
      else if (moduleId === 'tickets' && !before) { type = 'New Ticket'; message = `Support ticket created${record.status ? ` (${record.status})` : ''}.`; }
      else if (['tasks', 'technicianJobs', 'workOrders', 'surveys', 'events', 'tickets'].includes(moduleId) && assigned) { type = 'Task Assignment'; message = 'A work assignment was created or changed.'; }
      else if (moduleId === 'projectPosts' && !before) { type = record.kind === 'Update' ? 'Project Update' : 'Project Comment'; message = `${record.kind === 'Update' ? 'Project progress updated' : 'New project comment'}${record.authorName ? ` by ${record.authorName}` : ''}.`; }
      else if (moduleId === 'projects' && (!before || assigned || before.status !== record.status || before.progress !== record.progress)) { type = 'Project Update'; message = !before ? 'A project was created.' : `Project updated${record.status ? ` (${record.status})` : ''}.`; }
      else if (moduleId === 'payments' && record.status === 'Received' && before?.status !== 'Received') { type = 'Payment Received'; message = record.type === 'Refund' ? 'A customer refund was recorded.' : 'A customer payment was received.'; }
      else if (before && before.status !== record.status) { type = 'Record Update'; message = `Status changed from ${before.status || 'unset'} to ${record.status || 'unset'}.`; }
      else if (!before) { type = 'Record Created'; message = `${definitions.get(moduleId)?.singular || 'Record'} created${record.status ? ` (${record.status})` : ''}.`; }
      else if (assigned) { type = 'Record Assigned'; message = 'Record responsibility was assigned or changed.'; }
      if (!type) continue;
      const audit = (store.auditLogs || []).find(row => row.module === moduleId && row.recordId === record.id && !(previous.auditLogs || []).some(old => old.id === row.id));
      const version = hash(JSON.stringify([audit?.id, record.deletedAt, record.archivedAt, removed, record.updatedAt || record.createdAt || now.toISOString(), before?.status, record.status, record.progress, ...assignments.map(field => record[field])]));
      events.push({ key: `event:${moduleId}:${record.id}:${type}:${version}`, type, moduleId, record: moduleId === 'vault' ? { id: record.id, name: 'Credential reference', status: record.status } : record, message, severity: 'info', kind: 'event', occurredAt: now.toISOString(), actorMemberId });
    }
  }
  return events;
}

/** Full server data only. Every delivered row belongs to one active workspace member. */
export function synchronizeNotifications(initial: Store, now = new Date(), previous?: Store, actorMemberId?: string): { store: Store; changed: number } {
  const store = recalculate(structuredClone(initial), now), rows = store.notifications ||= [];
  let changed = 0;
  const alerts: Delivery[] = getAlerts(store, now).flatMap(alert => {
    const record = (store[alert.moduleId] || []).find(row => row.id === alert.recordId);
    if (!record || record.demo === true) return [];
    const trigger = ({ 'AMC Renewal': 'AMC Expiring', 'License Renewal': 'License Expiring', 'Low Stock': 'Low Stock', 'Payment Overdue': 'Payment Overdue', 'Project Deadline': 'Project Due' } as Record<string, string>)[alert.type];
    const rule = trigger ? (store.automations || []).find(row => live(row) && row.trigger === trigger) : undefined;
    if (rule?.enabled === false || rule?.daysBefore !== undefined && alert.days !== undefined && alert.days > Number(rule.daysBefore)) return [];
    return [{ key: `alert:${alert.id}:${alert.severity}`, type: alert.type, moduleId: alert.moduleId, record, message: alert.message, severity: alert.severity, kind: 'alert', occurredAt: now.toISOString() }];
  });
  const currentAlerts = new Set<string>();
  for (const delivery of [...alerts, ...(previous ? mutationEvents(store, previous, now, actorMemberId) : [])]) for (const member of recipients(store, delivery)) {
    const key = `${delivery.key}:member:${member.id}`;
    if (delivery.kind === 'alert') currentAlerts.add(key);
    const existing = rows.find(row => row.deliveryVersion === 1 && row.deliveryKey === key && (delivery.kind === 'event' || row.status !== 'Resolved'));
    if (existing) {
      if (existing.message !== delivery.message || existing.name !== (delivery.record.name || delivery.record.id)) { existing.message = delivery.message; existing.name = delivery.record.name || delivery.record.id; existing.updatedAt = now.toISOString(); changed++; }
      continue;
    }
    const episode = rows.filter(row => row.deliveryKey === key).length;
    rows.push({ id: `NOT-${hash(`${key}:${episode}`)}`, name: delivery.record.name || delivery.record.id, message: delivery.message, type: delivery.type, severity: delivery.severity, sourceModule: delivery.moduleId, sourceId: delivery.record.id, sourceScope: ['Record Deleted', 'Record Archived'].includes(delivery.type) ? notificationScope(delivery.record) : undefined, openModule: delivery.moduleId === 'projectPosts' ? 'projects' : delivery.moduleId, openRecordId: delivery.moduleId === 'projectPosts' ? delivery.record.project : delivery.record.id, recipientUserId: member.id, recipient: member.employee || member.technician, recipientName: member.name, channel: 'In-App', status: 'Delivered', read: false, deliveryVersion: 1, deliveryKey: key, notificationKind: delivery.kind, occurredAt: delivery.occurredAt, date: businessDate(now), createdAt: now.toISOString(), systemGenerated: true });
    changed++;
  }
  for (const row of rows) if (row.deliveryVersion === 1 && row.notificationKind === 'alert' && row.status !== 'Resolved' && !currentAlerts.has(row.deliveryKey)) {
    row.status = 'Resolved'; row.resolvedAt = now.toISOString(); changed++;
  }
  return { store, changed };
}

export function inboxNotifications(store: Store, user: AccessUser, readDates: Record<string, string> = {}, clearedDates: Record<string, string> = {}): ERPRecord[] {
  return (store.notifications || [])
    .filter(row => !clearedDates[row.id] && !row.deletedAt && !row.archivedAt && row.status !== 'Resolved' && canViewRecord(store, user, 'notifications', row))
    .map((row): ERPRecord => {
      const safe: ERPRecord = { ...row, read: Boolean(readDates[row.id]), readAt: readDates[row.id], status: readDates[row.id] ? 'Read' : 'Delivered' };
      delete safe.sourceScope;
      return safe;
    })
    .sort((a, b) => Number(a.read) - Number(b.read) || String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
