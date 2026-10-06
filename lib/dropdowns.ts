import { applyMutation, type Actor } from './engine.ts';
import { canCreateDropdownOption, type AccessUser } from './access.ts';
import { getDropdownConfig, resolveModules, type ERPRecord, type Store } from './schema.ts';

export type CreateOptionInput = { moduleId: string; fieldKey: string; name: unknown; expectedRevision: unknown; revision: number };
export type CreateOptionResult = { store: Store; value: string; reused: boolean; record?: ERPRecord };
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const identity = (value: string) => normalize(value).toLocaleLowerCase('en-IN');

/** Persist a permitted human classification while keeping workflow and security enums fixed. */
export function createDropdownOption(store: Store, user: AccessUser, input: CreateOptionInput, actor?: Actor): CreateOptionResult {
  if (input.expectedRevision !== input.revision) throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
  const module = resolveModules(store).find(item => item.id === input.moduleId);
  const field = module?.fields.find(item => item.key === input.fieldKey);
  if (!module || !field) throw new Error('Unknown dropdown field.');
  const config = getDropdownConfig(module.id, field);
  if (!config || config.kind === 'relation') throw new Error(config?.kind === 'relation' ? 'Create the related record using its complete form.' : 'This dropdown uses fixed system options.');
  if (!canCreateDropdownOption(store, user, module.id, field)) throw new Error('FORBIDDEN: You cannot add choices to this field.');
  if (typeof input.name !== 'string' || /[\u0000-\u001f\u007f]/.test(input.name)) throw new Error('Enter an option label with 1–80 visible characters.');
  const name = normalize(input.name);
  if (!name || name.length > 80 || /^__(?:create|new|add)/i.test(name)) throw new Error('Enter an option label with 1–80 visible characters.');
  const existing = field.options?.find(option => identity(option) === identity(name));
  if (existing) return { store, value: existing, reused: true };
  const targetModule = config.kind === 'dictionary' ? 'categories' : config.kind === 'status' ? 'customStatuses' : 'dropdownOptions';
  const data = config.kind === 'dictionary' ? { name, type: config.dictionary, status: 'Active' } : config.kind === 'status' ? { name, moduleId: module.id, color: '#64748b', terminal: false, status: 'Active' } : { name, moduleId: module.id, fieldKey: field.key, status: 'Active' };
  const result = applyMutation(store, targetModule, 'create', data, undefined, actor || { id: user.userId, name: user.displayName, role: user.role });
  result.record.createdById = user.userId;
  return { store: result.store, value: name, reused: false, record: result.record };
}
