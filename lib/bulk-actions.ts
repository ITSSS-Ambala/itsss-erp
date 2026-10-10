import type { Module, ERPRecord } from './schema.ts';

export function parseBulkAction(raw: unknown, module: Module): { ids: string[]; operation: 'delete'|'archive'|'update'; data: Partial<ERPRecord> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose records and a bulk action.');
  const { ids, operation, data } = raw as Record<string, unknown>;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Select between 1 and 500 unique records.');
  if (!['delete', 'archive', 'update'].includes(String(operation))) throw new Error('Unsupported bulk action.');
  let changes: Partial<ERPRecord> = {};
  if (operation === 'update') {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1) throw new Error('Choose one status or assignment field.');
    const [key, value] = Object.entries(data)[0];
    const field = module.fields.find(field => field.key === key);
    if (!field || !(key === 'status' && ['select','radio'].includes(field.type) || field.relation === 'employees' && field.type === 'relation')) throw new Error('This field does not support bulk changes.');
    if (typeof value !== 'string' || !value) throw new Error('Choose a status or employee.');
    changes = { [key]: value };
  } else if (data && Object.keys(data).length) throw new Error('This bulk action does not accept record changes.');
  return { ids: ids as string[], operation: operation as 'delete'|'archive'|'update', data: changes };
}
