import { getDropdownConfig, moduleById, resolveModules, type ERPRecord, type Module, type Store } from './schema.ts';

export type Actor = string | { id?: string; name?: string; email?: string; role?: string; [key: string]: unknown };
export type Action = 'create' | 'update' | 'delete' | 'restore' | 'duplicate' | 'archive' | 'permanentDelete';
// Archives retain accounting history. Only deleted records are removed from ledgers.
const live = (records: ERPRecord[] = []) => records.filter(r => !r.deletedAt);
const active = (records: ERPRecord[] = []) => live(records).filter(r => !r.archivedAt);
const n = (value: unknown): number => Number(value || 0);
const sum = (records: ERPRecord[], key: string) => records.reduce((total, record) => total + n(record[key]), 0);
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const uid = (prefix = 'REC') => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const iso = () => new Date().toISOString();
const actorName = (actor?: Actor) => typeof actor === 'string' ? actor : actor?.name || actor?.email || 'ITSSS team';
const moduleFor = (id: string, store: Store): Module | undefined => resolveModules(store).find(m => m.id === id) || moduleById[id];
const get = (store: Store, moduleId: string, id: string): ERPRecord | undefined => live(store[moduleId]).find(r => r.id === id);
const isApproved = (record: ERPRecord) => record.approvalStatus === 'Approved' || ['Approved', 'Paid', 'Reimbursed'].includes(record.status);
const isReceived = (record: ERPRecord) => record.status === 'Received';

/** Arithmetic only: numbers, field keys, parentheses and + - * / %. Never executes code. */
export function evaluateFormula(expression: string, record: Partial<ERPRecord>): number {
  if (!expression || expression.length > 256) throw new Error('Formula must contain 1–256 characters.');
  const tokens = expression.match(/(?:\d+(?:\.\d+)?|\.\d+)|[A-Za-z][A-Za-z0-9_]*|[()+\-*/%]/g) || [];
  if (tokens.join('') !== expression.replace(/\s/g, '')) throw new Error('Formula supports field keys, numbers, parentheses and arithmetic operators only.');
  let index = 0;
  const primary = (): number => {
    const token = tokens[index++];
    if (token === '+') return primary();
    if (token === '-') return -primary();
    if (token === '(') { const value = addition(); if (tokens[index++] !== ')') throw new Error('Formula parentheses do not match.'); return value; }
    if (!token) throw new Error('Formula is incomplete.');
    if (/^(\d|\.)/.test(token)) return Number(token);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(token) || ['constructor', 'prototype', '__proto__'].includes(token)) throw new Error('Invalid formula field.');
    const value = record[token] ?? 0;
    if (!Number.isFinite(Number(value))) throw new Error(`Formula field ${token} must be numeric.`);
    return Number(value);
  };
  const multiplication = (): number => { let value = primary(); while (['*', '/', '%'].includes(tokens[index])) { const operator = tokens[index++], operand = primary(); if ((operator === '/' || operator === '%') && !operand) throw new Error('Formula cannot divide by zero.'); value = operator === '*' ? value * operand : operator === '/' ? value / operand : value % operand; } return value; };
  const addition = (): number => { let value = multiplication(); while (['+', '-'].includes(tokens[index])) { const operator = tokens[index++], operand = multiplication(); value = operator === '+' ? value + operand : value - operand; } return value; };
  const result = addition();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid or nonfinite formula result.');
  return round(result);
}

export function validateRecord(moduleId: string, data: Partial<ERPRecord>, store: Store): string[] {
  const module = moduleFor(moduleId, store);
  if (!module) return [`Unknown module: ${moduleId}`];
  const errors: string[] = [];
  for (const field of module.fields) {
    const value = data[field.key];
    if (field.type === 'formula') continue;
    if (field.required && (value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0))) errors.push(`${field.label} is required.`);
    if (value === undefined || value === null || value === '') continue;
    if (['currency', 'number'].includes(field.type)) {
      if (!Number.isFinite(Number(value))) errors.push(`${field.label} must be a finite number.`);
      else if (Number(value) < 0 && !(moduleId === 'stockHistory' && ['quantity', 'reservedDelta'].includes(field.key))) errors.push(`${field.label} cannot be negative.`);
    }
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) errors.push(`${field.label} must be a valid email address.`);
    if (field.type === 'tel' && !/^[+\d\s().-]+$/.test(String(value))) errors.push(`${field.label} must be a valid phone number.`);
    if (field.type === 'url' && !/^https?:\/\//i.test(String(value))) errors.push(`${field.label} must begin with http:// or https://.`);
    if (field.type === 'date') {
      const parsed = new Date(`${String(value)}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) errors.push(`${field.label} must be a valid date.`);
    }
    if (field.type === 'datetime-local' && Number.isNaN(new Date(String(value)).getTime())) errors.push(`${field.label} must be a valid date and time.`);
    if (field.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(value))) errors.push(`${field.label} must be a valid time.`);
    if (['select', 'radio'].includes(field.type) && (typeof value !== 'string' || !field.relation && !field.options?.includes(value))) errors.push(`${field.label} must be one of the configured options.`);
    if (field.type === 'multiselect') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) errors.push(`${field.label} must be a list of unique selections.`);
      else if (!field.relation && value.some(item => !field.options?.includes(item))) errors.push(`${field.label} must contain configured options only.`);
    }
    if (field.type === 'relation' && typeof value !== 'string') errors.push(`${field.label} must identify a related record.`);
    if (field.relation) {
      const values = Array.isArray(value) ? value : [value];
      for (const relationId of values) if (!get(store, field.relation, String(relationId))) errors.push(`${field.label} refers to a missing or deleted record.`);
    }
  }
  const uniqueKeys: Record<string, string[]> = { products: ['sku'], assets: ['serialNumber'], serials: ['name'], users: ['email'], customModules: ['moduleId'], roles: ['name'] };
  for (const key of uniqueKeys[moduleId] || []) if (data[key] && live(store[moduleId]).some(r => r.id !== data.id && String(r[key]).toLowerCase() === String(data[key]).toLowerCase())) errors.push(`${key} already exists.`);
  if (['categories', 'customStatuses', 'dropdownOptions'].includes(moduleId)) {
    const normalized = (value: unknown) => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
    const label = String(data.name || '').trim();
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label) || /^__(?:create|new|add)/i.test(label)) errors.push('Option labels must contain 1–80 visible characters.');
    const sameScope = (row: ERPRecord) => moduleId === 'categories' ? row.type === data.type : row.moduleId === data.moduleId && (moduleId !== 'dropdownOptions' || row.fieldKey === data.fieldKey);
    if (live(store[moduleId]).some(row => !row.archivedAt && row.status !== 'Inactive' && row.id !== data.id && sameScope(row) && normalized(row.name) === normalized(data.name))) errors.push('This option already exists.');
    if (moduleId !== 'categories') {
      const target = resolveModules(store).find(item => item.id === data.moduleId);
      const field = target?.fields.find(item => item.key === (moduleId === 'customStatuses' ? 'status' : data.fieldKey));
      const config = field && target ? getDropdownConfig(target.id, field) : undefined;
      if (!config || config.kind !== (moduleId === 'customStatuses' ? 'status' : 'option')) errors.push('This field does not allow configurable options.');
    }
  }
  if (data.progress !== undefined && (n(data.progress) < 0 || n(data.progress) > 100)) errors.push('Progress must be between 0 and 100.');
  if (data.gstRate !== undefined && (n(data.gstRate) < 0 || n(data.gstRate) > 100)) errors.push('GST rate must be between 0 and 100.');
  if (data.percentage !== undefined && n(data.percentage) > 100) errors.push('Commission percentage cannot exceed 100.');
  if (data.probability !== undefined && n(data.probability) > 100) errors.push('Probability cannot exceed 100.');
  for (const [from, to] of [['startDate', 'endDate'], ['startDate', 'expiryDate'], ['startDate', 'dueDate'], ['startTime', 'endTime'], ['startAt', 'endAt'], ['registrationDate', 'expiryDate']]) if (data[from] && data[to] && String(data[to]) < String(data[from])) errors.push(`${to} must be on or after ${from}.`);
  if (moduleId === 'customModules') {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(String(data.moduleId || ''))) errors.push('Module ID must start with a lowercase letter and contain letters or numbers.');
    if (moduleById[String(data.moduleId)]) errors.push('This module ID belongs to a built-in module.');
  }
  if (moduleId === 'customFields') {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(String(data.key || ''))) errors.push('Field key must contain letters, numbers or underscores.');
    if (['id', 'deletedAt', 'deletedBy', 'deletionReason', 'createdAt', 'createdBy', 'updatedAt', 'archivedAt', 'archivedBy', 'permanentlyDeletedAt', 'systemGenerated', 'automationKey', '__proto__', 'constructor', 'prototype'].includes(String(data.key))) errors.push('This field key is reserved.');
    if (moduleById[String(data.moduleId)]?.fields.some(field => field.key === data.key)) errors.push('Custom fields must use a new key; built-in fields cannot be replaced.');
    if (live(store.customFields).some(r => r.id !== data.id && r.moduleId === data.moduleId && r.key === data.key)) errors.push('A field with this key already exists on the module.');
    if (data.type === 'formula') try { const expression = String(data.formula || ''); const sample = Object.fromEntries((expression.match(/[A-Za-z][A-Za-z0-9_]*/g) || []).map(key => [key, 1])); evaluateFormula(expression, sample); } catch (error) { errors.push(error instanceof Error ? error.message : 'Invalid formula.'); }
    if (data.type === 'formula') {
      const definitions = live(store.customFields).filter(r => r.moduleId === data.moduleId && r.id !== data.id && r.type === 'formula').concat(data as ERPRecord);
      const dependencies = new Map(definitions.map(r => [r.key, String(r.formula || '').match(/[A-Za-z][A-Za-z0-9_]*/g) || []]));
      const visited = new Set<string>(), visiting = new Set<string>();
      const cycle = (key: string): boolean => { if (visiting.has(key)) return true; if (visited.has(key)) return false; visiting.add(key); for (const dependency of dependencies.get(key) || []) if (dependencies.has(dependency) && cycle(dependency)) return true; visiting.delete(key); visited.add(key); return false; };
      if ([...dependencies.keys()].some(cycle)) errors.push('Formula fields cannot contain circular references.');
    }
  }
  if (['stockTransfers', 'allocations', 'purchaseRequests', 'purchaseOrders', 'purchases'].includes(moduleId)) {
    if (!Number.isFinite(Number(data.quantity)) || n(data.quantity) <= 0) errors.push('Quantity must be greater than zero.');
    if (data.quantity !== undefined && !Number.isInteger(Number(data.quantity))) errors.push('Quantity must be a whole number.');
  }
  if (['inventory', 'allocations'].includes(moduleId)) for (const key of ['quantity', 'reserved', 'damaged', 'usedQuantity', 'returnedQuantity', 'wastage']) if (data[key] !== undefined && !Number.isInteger(Number(data[key]))) errors.push(`${key} must be a whole number.`);
  if (moduleId === 'stockTransfers' && data.fromLocation === data.toLocation) errors.push('Source and destination locations must be different.');
  if (moduleId === 'allocations' && n(data.usedQuantity) + n(data.returnedQuantity) + n(data.wastage) > n(data.quantity)) errors.push('Used, returned and wasted quantities cannot exceed the allocation.');
  if (moduleId === 'inventory' && n(data.reserved) + n(data.damaged) > n(data.quantity)) errors.push('Reserved and damaged stock cannot exceed physical stock.');
  if (moduleId === 'inventory' && live(store.inventory).some(r => r.id !== data.id && r.product === data.product && r.location === data.location)) errors.push('Stock for this product and location already exists. Adjust the existing stock record.');
  if (moduleId === 'amc' && n(data.visitsCompleted) > n(data.visits)) errors.push('Completed visits cannot exceed contracted visits.');
  if (moduleId === 'payroll' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(data.month || ''))) errors.push('Salary month must use YYYY-MM format.');
  if (['payments', 'supplierPayments', 'expenses', 'employeeExpenses', 'income', 'receivables', 'payables'].includes(moduleId) && (!Number.isFinite(Number(data.amount)) || n(data.amount) <= 0)) errors.push('Amount must be greater than zero.');
  if (['payments', 'receivables', 'workOrders', 'technicianJobs'].includes(moduleId) && data.project) {
    const linkedProject = get(store, 'projects', String(data.project));
    if (linkedProject && data.customer && linkedProject.customer && linkedProject.customer !== data.customer) errors.push('Customer must match the selected project.');
  }
  if (data.site && data.customer && moduleId !== 'sites') {
    const linkedSite = get(store, 'sites', String(data.site));
    if (linkedSite?.customer && linkedSite.customer !== data.customer) errors.push('Site must belong to the selected customer.');
  }
  if (data.site && data.project) {
    const linkedProject = get(store, 'projects', String(data.project));
    if (linkedProject?.site && linkedProject.site !== data.site) errors.push('Site must match the selected project.');
  }
  if (moduleId === 'tasks' && (data.dependsOn || data.parentTask)) {
    for (const key of ['dependsOn', 'parentTask']) {
      let target = String(data[key] || '');
      const visited = new Set<string>();
      while (target) {
        if (target === data.id || visited.has(target)) { errors.push('Task dependencies and subtasks cannot contain circular references.'); break; }
        visited.add(target); target = String(get(store, 'tasks', target)?.[key] || '');
      }
    }
  }
  if (moduleId === 'payments' && data.project && data.status === 'Received') {
    const linkedProject = get(store, 'projects', String(data.project));
    const paid = live(store.payments).filter(r => r.id !== data.id && r.project === data.project && isReceived(r)).reduce((total, payment) => total + (payment.type === 'Refund' ? -1 : 1) * n(payment.amount), 0);
    if (data.type === 'Refund' && n(data.amount) > paid) errors.push('Refund cannot exceed payments received for the project.');
    if (data.type !== 'Refund' && linkedProject && paid + n(data.amount) > n(linkedProject.value) + 0.005) errors.push('Payment exceeds the outstanding project balance.');
  }
  if (moduleId === 'supplierPayments' && data.purchase && data.status === 'Paid') {
    const purchase = get(store, 'purchases', String(data.purchase));
    if (purchase?.supplier && data.supplier !== purchase.supplier) errors.push('Supplier must match the selected purchase.');
    const paid = sum(live(store.supplierPayments).filter(r => r.id !== data.id && r.purchase === data.purchase && r.status === 'Paid'), 'amount');
    if (purchase && paid + n(data.amount) > purchaseTotal(purchase) + 0.005) errors.push('Payment exceeds the supplier purchase balance.');
  }
  if (['receivables', 'payables'].includes(moduleId) && n(data.paid) > n(data.amount)) errors.push('Paid amount cannot exceed the amount due.');
  if (moduleId === 'attendance' && data.checkIn && data.checkOut && String(data.checkOut) < String(data.checkIn)) errors.push('Check-out must be after check-in.');
  return [...new Set(errors)];
}

type StockEffect = { product: string; location: string; quantity: number; reserved: number };
function stockEffects(moduleId: string, record?: ERPRecord): StockEffect[] {
  if (!record || record.deletedAt) return [];
  if (moduleId === 'purchases' && record.status === 'Received') return [{ product: record.product, location: record.location, quantity: n(record.quantity), reserved: 0 }];
  if (moduleId === 'stockTransfers' && record.status === 'Completed') return [{ product: record.product, location: record.fromLocation, quantity: -n(record.quantity), reserved: 0 }, { product: record.product, location: record.toLocation, quantity: n(record.quantity), reserved: 0 }];
  if (moduleId === 'allocations' && ['Reserved', 'Issued', 'Used', 'Returned'].includes(record.status)) {
    const consumed = n(record.usedQuantity) + n(record.wastage);
    const reserved = record.status === 'Returned' ? 0 : n(record.quantity) - consumed - n(record.returnedQuantity);
    return [{ product: record.product, location: record.location, quantity: -consumed, reserved }];
  }
  return [];
}

function reconcileStock(store: Store, moduleId: string, before: ERPRecord | undefined, after: ERPRecord | undefined, actor?: Actor) {
  const combined = new Map<string, StockEffect>();
  for (const [effects, sign] of [[stockEffects(moduleId, before), -1], [stockEffects(moduleId, after), 1]] as [StockEffect[], number][]) for (const effect of effects) {
    const key = `${effect.product}\u0000${effect.location}`;
    const delta = combined.get(key) || { product: effect.product, location: effect.location, quantity: 0, reserved: 0 };
    delta.quantity += effect.quantity * sign;
    delta.reserved += effect.reserved * sign;
    combined.set(key, delta);
  }
  store.inventory ||= [];
  store.stockHistory ||= [];
  for (const effect of combined.values()) {
    if (!effect.quantity && !effect.reserved) continue;
    let stock = live(store.inventory).find(r => r.product === effect.product && r.location === effect.location);
    if (!stock) {
      if (effect.quantity < 0 || effect.reserved > 0) throw new Error(`No stock available at ${effect.location}.`);
      const product = get(store, 'products', effect.product);
      stock = { id: uid('STK'), name: `${product?.name || 'Product'} · ${effect.location}`, product: effect.product, location: effect.location, quantity: 0, reserved: 0, damaged: 0, unitCost: n(product?.purchasePrice), createdAt: iso() };
      store.inventory.push(stock);
    }
    const quantity = round(n(stock.quantity) + effect.quantity);
    const reserved = round(n(stock.reserved) + effect.reserved);
    if (quantity < -0.005 || reserved < -0.005 || reserved + n(stock.damaged) > quantity + 0.005) throw new Error(`Insufficient available stock at ${effect.location}. Physical and reserved stock must stay nonnegative.`);
    stock.quantity = Math.max(0, quantity);
    stock.reserved = Math.max(0, reserved);
    stock.updatedAt = iso();
    store.stockHistory.push({ id: uid('MOV'), name: `${moduleById[moduleId]?.singular || moduleId} · ${after?.name || before?.name || ''}`, product: effect.product, location: effect.location, quantity: effect.quantity, reservedDelta: effect.reserved, type: moduleId === 'purchases' ? 'Stock In' : moduleId === 'stockTransfers' ? 'Transfer' : 'Allocation', sourceModule: moduleId, sourceId: after?.id || before?.id, date: iso(), actor: actorName(actor) });
  }
}

function purchaseTotal(record: ERPRecord): number { return round(n(record.quantity) * n(record.rate) * (1 + n(record.gstRate) / 100)); }
function dateStatus(balance: number, paid: number, dueDate: string | undefined, now = new Date()) { return balance <= 0.005 ? 'Paid' : dueDate && dueDate < now.toISOString().slice(0, 10) ? 'Overdue' : paid > 0 ? 'Partially Paid' : 'Unpaid'; }

export function recalculate(store: Store, now = new Date()): Store {
  for (const stock of live(store.inventory)) {
    stock.available = round(n(stock.quantity) - n(stock.reserved) - n(stock.damaged));
    stock.value = round(n(stock.quantity) * n(stock.unitCost || get(store, 'products', stock.product)?.purchasePrice));
  }
  for (const record of live(store.purchaseOrders).concat(live(store.purchases))) record.total = purchaseTotal(record);
  for (const purchase of live(store.purchases)) {
    purchase.paidAmount = sum(live(store.supplierPayments).filter(r => r.purchase === purchase.id && r.status === 'Paid'), 'amount');
    purchase.balanceDue = round(Math.max(0, purchaseTotal(purchase) - purchase.paidAmount));
    purchase.paymentStatus = dateStatus(purchase.balanceDue, purchase.paidAmount, purchase.dueDate, now);
  }
  for (const project of live(store.projects)) {
    const materials = live(store.allocations).filter(r => r.project === project.id && !['Draft', 'Cancelled'].includes(r.status)).reduce((total, allocation) => { allocation.unitCost ??= n(get(store, 'products', allocation.product)?.purchasePrice); return total + (n(allocation.usedQuantity) + n(allocation.wastage)) * n(allocation.unitCost); }, 0);
    const expenses = sum(live(store.expenses).filter(r => r.project === project.id && isApproved(r)), 'amount');
    const claims = sum(live(store.employeeExpenses).filter(r => r.project === project.id && isApproved(r)), 'amount');
    project.materialCost = round(materials);
    project.actualCost = round(materials + expenses + claims);
    project.profit = round(n(project.value) - project.actualCost);
    project.margin = n(project.value) ? round(project.profit / n(project.value) * 100) : 0;
    project.expectedProfit = round(n(project.value) - n(project.estimatedCost));
    project.costVariance = round(project.actualCost - n(project.estimatedCost));
    project.paidAmount = round(live(store.payments).filter(r => r.project === project.id && isReceived(r)).reduce((total, payment) => total + (payment.type === 'Refund' ? -1 : 1) * n(payment.amount), 0));
    project.balanceDue = round(Math.max(0, n(project.value) - project.paidAmount));
    project.paymentStatus = dateStatus(project.balanceDue, project.paidAmount, project.paymentDueDate || project.dueDate, now);
    if (project.status === 'Completed') project.progress = 100;
  }
  for (const record of live(store.receivables).concat(live(store.payables))) {
    record.balance = round(Math.max(0, n(record.amount) - n(record.paid)));
    record.status = dateStatus(record.balance, n(record.paid), record.dueDate, now);
  }
  for (const contract of live(store.amc)) contract.visitsRemaining = Math.max(0, n(contract.visits) - n(contract.visitsCompleted));
  for (const contract of live(store.recurring)) { const months = contract.cycle === 'Annual' ? 12 : contract.cycle === 'Quarterly' ? 3 : 1; contract.mrr = round(n(contract.amount) / months); contract.arr = round(n(contract.amount) * 12 / months); }
  for (const payroll of live(store.payroll)) payroll.netSalary = round(n(payroll.salary) + n(payroll.bonus) + n(payroll.incentives) + n(payroll.reimbursements) - n(payroll.deductions) - n(payroll.advances));
  for (const commission of live(store.commissions)) commission.amount = round(commission.type === 'Fixed' ? n(commission.fixedAmount) : n(commission.revenue || get(store, 'projects', commission.project)?.value) * n(commission.percentage) / 100);
  for (const campaign of live(store.campaigns)) {
    campaign.cpc = n(campaign.clicks) ? round(n(campaign.spend) / n(campaign.clicks)) : 0;
    campaign.cpl = n(campaign.leadCount) ? round(n(campaign.spend) / n(campaign.leadCount)) : 0;
    campaign.conversionRate = n(campaign.clicks) ? round(n(campaign.conversions) / n(campaign.clicks) * 100) : 0;
    campaign.roas = n(campaign.spend) ? round(n(campaign.conversionRevenue) / n(campaign.spend)) : 0;
  }
  for (const session of live(store.remoteSupport)) session.hours = session.startTime && session.endTime ? round((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 3600000) : 0;
  for (const record of live(store.attendance)) record.hours = record.checkIn && record.checkOut ? round((new Date(`2000-01-01T${record.checkOut}`).getTime() - new Date(`2000-01-01T${record.checkIn}`).getTime()) / 3600000) : 0;
  for (const customer of live(store.customers)) {
    const projects = live(store.projects).filter(r => r.customer === customer.id && r.status !== 'Cancelled');
    customer.totalRevenue = sum(projects, 'value'); customer.totalCost = sum(projects, 'actualCost'); customer.lifetimeProfit = round(customer.totalRevenue - customer.totalCost); customer.totalProjects = projects.length; customer.balanceDue = sum(projects, 'balanceDue');
  }
  for (const supplier of live(store.suppliers)) {
    supplier.totalPurchases = sum(live(store.purchases).filter(r => r.supplier === supplier.id && r.status === 'Received'), 'total');
    supplier.totalPaid = sum(live(store.supplierPayments).filter(r => r.supplier === supplier.id && r.status === 'Paid'), 'amount');
    supplier.balanceDue = round(Math.max(0, supplier.totalPurchases - supplier.totalPaid));
  }
  const formulaFields = live(store.customFields).filter(r => r.type === 'formula' && r.status !== 'Inactive');
  const resolved = new Set<string>();
  const calculateField = (field: ERPRecord, stack = new Set<string>()) => {
    const fieldId = `${field.moduleId}.${field.key}`;
    if (resolved.has(fieldId)) return;
    if (stack.has(fieldId)) return;
    const nextStack = new Set(stack).add(fieldId);
    for (const dependency of String(field.formula || '').match(/[A-Za-z][A-Za-z0-9_]*/g) || []) { const parent = formulaFields.find(r => r.moduleId === field.moduleId && r.key === dependency); if (parent) calculateField(parent, nextStack); }
    for (const record of live(store[field.moduleId])) try { record[field.key] = evaluateFormula(field.formula || '', record); delete record[`${field.key}Error`]; } catch (error) { record[field.key] = null; record[`${field.key}Error`] = error instanceof Error ? error.message : 'Invalid formula'; }
    resolved.add(fieldId);
  };
  for (const field of formulaFields) calculateField(field);
  return store;
}

function addSystemRecord(store: Store, moduleId: string, data: Omit<ERPRecord, 'id'> & { id?: string }): ERPRecord {
  store[moduleId] ||= [];
  const record: ERPRecord = { ...data, id: data.id || uid(moduleId.slice(0, 3).toUpperCase()), createdAt: iso(), updatedAt: iso(), systemGenerated: true };
  store[moduleId].push(record); return record;
}

function onWorkflow(store: Store, moduleId: string, record: ERPRecord, before?: ERPRecord) {
  const enabled = (trigger: string) => !live(store.automations).some(r => r.trigger === trigger && r.enabled === false);
  if (moduleId === 'leads' && record.status === 'Won' && enabled('Lead Won')) {
    const existingProject = (store.projects || []).find(r => r.lead === record.id);
    if (existingProject) { record.project = existingProject.id; record.customer ||= existingProject.customer; return; }
    let customer = record.customer ? get(store, 'customers', record.customer) : live(store.customers).find(r => (record.email && r.email?.toLowerCase() === record.email?.toLowerCase()) || (record.mobile && String(r.mobile) === String(record.mobile)));
    if (!customer) customer = addSystemRecord(store, 'customers', { name: record.company || record.name, company: record.company, contactPersons: record.contactPerson || record.name, mobile: record.mobile, email: record.email, city: record.city, state: record.state, billingAddress: record.address, installationAddress: record.address, gstNumber: record.gstNumber, customerSince: new Date().toISOString().slice(0, 10), category: 'SME', status: 'Active' });
    record.customer = customer.id;
    const linkedSite = record.address ? addSystemRecord(store, 'sites', { name: `${record.company || record.name} · Main site`, customer: customer.id, address: record.address, city: record.city, state: record.state, phone: record.mobile, email: record.email, category: 'Office', status: 'Installation' }) : undefined;
    const created = addSystemRecord(store, 'projects', { name: `${record.company || record.name} · ${record.requirement || get(store, 'services', record.service)?.name || 'New project'}`.slice(0, 120), lead: record.id, customer: customer.id, site: linkedSite?.id, value: n(record.budget), estimatedCost: 0, status: 'Planning', progress: 0, priority: record.priority || 'Normal', city: record.city, salesperson: record.assignedTo, service: record.service, startDate: new Date().toISOString().slice(0, 10), dueDate: record.expectedClosing, notes: record.notes });
    record.project = created.id;
    addSystemRecord(store, 'activities', { name: `Project created from ${record.name}`, module: 'projects', recordId: created.id, action: 'Lead Won', actor: 'Automation', date: iso(), details: `Lead ${record.id} linked to customer ${customer.id}.` });
  }
  if (moduleId === 'projects' && record.status === 'Completed' && before?.status !== 'Completed' && enabled('Project Completed')) {
    record.completedDate ||= new Date().toISOString().slice(0, 10);
    if (!(store.followups || []).some(r => r.automationKey === `completion:${record.id}`)) addSystemRecord(store, 'followups', { name: `Completion follow-up · ${record.name}`, project: record.id, customer: record.customer, type: 'Phone Call', assignedTo: record.salesperson || record.manager, dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16), priority: 'Normal', status: 'Scheduled', automationKey: `completion:${record.id}`, notes: 'Confirm handover, satisfaction and AMC requirements.' });
  }
  if (moduleId === 'tickets' && !before && enabled('Ticket Created') && !record.technician) {
    const site = get(store, 'sites', record.site);
    record.technician = site?.technician || live(store.employees).find(r => r.role === 'Technician')?.id;
    if (record.technician) record.status = 'Assigned';
  }
}

export function applyMutation(initialStore: Store, moduleId: string, action: Action, data: Partial<ERPRecord>, id?: string, actor?: Actor): { store: Store; record: ERPRecord } {
  if (!['create', 'update', 'delete', 'restore', 'duplicate', 'archive', 'permanentDelete'].includes(action)) throw new Error('Unsupported mutation action.');
  const store: Store = structuredClone(initialStore);
  for (const allocation of store.allocations || []) allocation.unitCost ??= n(get(store, 'products', allocation.product)?.purchasePrice);
  const module = moduleFor(moduleId, store);
  if (!module) throw new Error(`Unknown module: ${moduleId}`);
  if (['auditLogs', 'activities', 'stockHistory'].includes(moduleId)) throw new Error('System history is read-only.');
  const safeData = Object.fromEntries(module.fields.filter(field => field.type !== 'formula' && Object.prototype.hasOwnProperty.call(data, field.key)).map(field => [field.key, data[field.key]]));
  store[moduleId] ||= [];
  const existing = id ? store[moduleId].find(r => r.id === id) : undefined;
  if (action !== 'create' && !existing) throw new Error('Record not found.');
  if (existing?.deletedAt && !['restore', 'duplicate', 'permanentDelete'].includes(action)) throw new Error('Restore this record before editing it.');
  if (action === 'restore' && !existing?.deletedAt && !existing?.archivedAt) throw new Error('This record is not deleted or archived.');
  if (action === 'permanentDelete' && !existing?.deletedAt) throw new Error('Move this record to the recycle bin before permanently deleting it.');
  const before = existing ? structuredClone(existing) : undefined;
  const now = iso();
  if (action === 'delete' && moduleId === 'projects' && live(store.payments).some(payment => payment.project === id && payment.status === 'Received')) throw new Error('Archive this project to retain its payment history. Remove its received payments before deleting it.');
  if (action === 'delete' && moduleId === 'purchases' && live(store.supplierPayments).some(payment => payment.purchase === id && payment.status === 'Paid')) throw new Error('Archive this purchase to retain its payment history. Remove its supplier payments before deleting it.');
  let record: ERPRecord;
  if (action === 'create' || action === 'duplicate') {
    record = { ...(action === 'duplicate' ? existing : {}), ...safeData, id: uid(moduleId.slice(0, 3).toUpperCase()), createdAt: now, updatedAt: now, createdBy: actorName(actor) };
    for (const key of ['deletedAt', 'deletedBy', 'deletionReason', 'archivedAt', 'systemGenerated', 'automationKey']) delete record[key];
    if (action === 'duplicate') {
      record.name = `${record.name || module.singular} (copy)`;
      if (moduleId === 'leads') { record.status = 'New'; delete record.project; delete record.customer; }
      if (moduleId === 'projects') { record.status = 'Planning'; record.progress = 0; delete record.lead; delete record.completedDate; }
      if (['purchases', 'stockTransfers', 'purchaseOrders', 'allocations'].includes(moduleId)) { record.status = 'Draft'; record.usedQuantity = 0; record.returnedQuantity = 0; record.wastage = 0; }
      if (['payments', 'supplierPayments'].includes(moduleId)) record.status = 'Pending';
      for (const uniqueKey of ['sku', 'serialNumber']) if (record[uniqueKey]) record[uniqueKey] += `-COPY-${record.id.slice(-4)}`;
      if (moduleId === 'users') record.email = '';
      if (moduleId === 'customModules') record.moduleId += `Copy${record.id.slice(-4).replace(/[^a-zA-Z0-9]/g, '')}`;
    }
    store[moduleId].push(record);
  } else {
    record = existing!;
    if (action === 'update') { Object.assign(record, safeData, { updatedAt: now }); }
    if (action === 'delete') { record.deletedAt = now; record.deletedBy = actorName(actor); record.deletionReason = data.deletionReason || 'Deleted by user'; }
    if (action === 'archive') { record.archivedAt = now; record.archivedBy = actorName(actor); record.updatedAt = now; }
    if (action === 'restore') { delete record.deletedAt; delete record.deletedBy; delete record.deletionReason; delete record.archivedAt; delete record.archivedBy; record.updatedAt = now; }
    if (action === 'permanentDelete') {
      const dependencies: string[] = [];
      for (const candidateModule of resolveModules(store)) for (const candidate of store[candidateModule.id] || []) {
        if (candidateModule.id === moduleId && candidate.id === record.id) continue;
        if (candidateModule.fields.some(field => field.relation === moduleId && (Array.isArray(candidate[field.key]) ? candidate[field.key].includes(record.id) : candidate[field.key] === record.id)) || (candidate.relatedModule === moduleId && candidate.relatedId === record.id)) dependencies.push(`${candidateModule.singular}: ${candidate.name || candidate.id}`);
      }
      if (dependencies.length) throw new Error(`This record is referenced by ${dependencies.slice(0, 3).join(', ')}${dependencies.length > 3 ? ` and ${dependencies.length - 3} more` : ''}. Remove those references before permanently deleting it.`);
      store[moduleId] = store[moduleId].filter(r => r.id !== record.id);
      record.permanentlyDeletedAt = now;
    }
  }
  for (const field of module.fields) if (['currency', 'number'].includes(field.type) && record[field.key] !== undefined && record[field.key] !== '') record[field.key] = field.type === 'currency' ? round(Number(record[field.key])) : Number(record[field.key]);
  if (!['delete', 'archive', 'permanentDelete'].includes(action)) {
    const errors = validateRecord(moduleId, record, store);
    if (errors.length) throw new Error(errors.join(' '));
  }
  if (moduleId === 'allocations') {
    if (before && n(before.usedQuantity) + n(before.wastage) > 0 && (before.product !== record.product || before.location !== record.location)) throw new Error('A consumed material allocation cannot change its product or source location.');
    record.unitCost = before?.unitCost ?? n(get(store, 'products', record.product)?.purchasePrice);
  }
  if (moduleId === 'inventory' && before && (before.product !== record.product || before.location !== record.location) && (n(before.quantity) > 0 || n(before.reserved) > 0)) throw new Error('Use a stock transfer to move existing stock. A stocked location cannot change its product or location.');
  reconcileStock(store, moduleId, action === 'create' || action === 'duplicate' ? undefined : before, record, actor);
  if (moduleId === 'inventory') {
    if (action === 'delete' && (n(before?.quantity) > 0 || n(before?.reserved) > 0)) throw new Error('Adjust stock to zero and release reservations before deleting this stock record.');
    const delta = action === 'delete' ? 0 : n(record.quantity) - (action === 'create' || action === 'duplicate' ? 0 : n(before?.quantity));
    if (delta) addSystemRecord(store, 'stockHistory', { name: record.name, product: record.product, location: record.location, quantity: delta, reservedDelta: n(record.reserved) - n(before?.reserved), type: 'Stock Adjustment', sourceModule: moduleId, sourceId: record.id, date: now, actor: actorName(actor), notes: record.adjustmentReason || '' });
  }
  if (!['delete', 'archive', 'permanentDelete'].includes(action)) onWorkflow(store, moduleId, record, before);
  recalculate(store);
  for (const financialProject of live(store.projects)) if (n(financialProject.paidAmount) < -0.005 || n(financialProject.paidAmount) > n(financialProject.value) + 0.005) throw new Error('This change would leave project receipts outside the contract value. Update related payments or refunds first.');
  for (const purchase of live(store.purchases)) if (n(purchase.paidAmount) > purchaseTotal(purchase) + 0.005 || (purchase.status !== 'Received' && n(purchase.paidAmount) > 0)) throw new Error('This change would leave supplier payments against an unreceived or insufficient purchase amount. Update related supplier payments first.');
  const actionLabel = { create: 'created', update: 'updated', delete: 'deleted', restore: 'restored', duplicate: 'duplicated', archive: 'archived', permanentDelete: 'permanently deleted' }[action];
  addSystemRecord(store, 'auditLogs', { name: `${module.singular} ${actionLabel}`, actor: actorName(actor), actorId: typeof actor === 'object' ? actor.id : undefined, action, module: moduleId, recordId: record.id, date: now, device: typeof actor === 'object' ? actor.device || 'Web browser' : 'Web browser', ip: typeof actor === 'object' ? actor.ip || 'Unavailable' : 'Unavailable', oldValue: before ? JSON.stringify(before) : '', newValue: JSON.stringify(record) });
  addSystemRecord(store, 'activities', { name: `${record.name || module.singular} · ${action}`, module: moduleId, recordId: record.id, action: before?.status !== record.status && before ? 'Status Changed' : action, actor: actorName(actor), date: now, details: `${module.singular} ${action}${before?.status !== record.status && before ? ` (${before.status || '—'} → ${record.status || '—'})` : ''}.` });
  return { store, record };
}

export type Alert = { id: string; name: string; message: string; type: string; moduleId: string; recordId: string; date?: string; severity: 'info' | 'warning' | 'critical'; recipient?: string; days?: number };
export function getAlerts(store: Store, now = new Date()): Alert[] {
  const today = now.toISOString().slice(0, 10);
  const alerts: Alert[] = [];
  const push = (moduleId: string, record: ERPRecord, type: string, message: string, severity: Alert['severity'], date?: string, recipient?: string) => alerts.push({ id: `${type}:${record.id}:${date || today}`, name: record.name, message, type, moduleId, recordId: record.id, date, severity, recipient, days: date ? Math.ceil((new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000) : undefined });
  for (const followup of active(store.followups)) if (followup.status === 'Scheduled' && String(followup.dueAt).slice(0, 10) <= today) push('followups', followup, 'Follow-up Due', `Follow-up ${String(followup.dueAt).slice(0, 10) < today ? 'overdue' : 'due today'}`, 'warning', followup.dueAt, followup.assignedTo);
  for (const project of active(store.projects)) {
    if (!['Completed', 'Cancelled', 'On Hold'].includes(project.status) && project.dueDate && project.dueDate <= new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10)) push('projects', project, 'Project Deadline', project.dueDate < today ? 'Project completion is overdue' : 'Project deadline is approaching', project.dueDate < today ? 'critical' : 'warning', project.dueDate, project.manager);
    const balance = n(project.value) - live(store.payments).filter(r => r.project === project.id && isReceived(r)).reduce((total, payment) => total + (payment.type === 'Refund' ? -1 : 1) * n(payment.amount), 0);
    if (balance > 0 && (project.paymentDueDate || project.dueDate) < today) push('projects', project, 'Payment Overdue', `₹${round(balance).toLocaleString('en-IN')} outstanding`, 'critical', project.paymentDueDate || project.dueDate);
    if (n(project.actualCost) > n(project.estimatedCost) && n(project.estimatedCost) > 0) push('projects', project, 'Cost Overrun', 'Actual cost exceeds the project estimate', 'warning');
  }
  for (const stock of live(store.inventory)) {
    const product = get(store, 'products', stock.product);
    const available = n(stock.quantity) - n(stock.reserved) - n(stock.damaged);
    if (product && available <= n(product.minimumStock)) push('inventory', stock, 'Low Stock', `${product.name}: ${available} available at ${stock.location}`, available <= 0 ? 'critical' : 'warning');
  }
  for (const [moduleId, dateKey, type] of [['amc', 'endDate', 'AMC Renewal'], ['licenses', 'expiryDate', 'License Renewal'], ['domains', 'expiryDate', 'Domain Renewal'], ['hosting', 'expiryDate', 'Hosting Renewal'], ['hosting', 'sslExpiry', 'SSL Expiry'], ['warranties', 'endDate', 'Warranty Expiry']] as string[][]) for (const contract of live(store[moduleId])) {
    if (['Cancelled', 'Renewed'].includes(contract.status) || !contract[dateKey]) continue;
    const days = Math.ceil((new Date(`${String(contract[dateKey]).slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);
    if (days <= 30) {
      push(moduleId, contract, type, days < 0 ? `Expired ${Math.abs(days)} days ago` : `Renewal due in ${days} day${days === 1 ? '' : 's'}`, days <= 7 ? 'critical' : 'warning', contract[dateKey], contract.assignedTo || contract.technician);
      const stage = days < 0 ? 'expired' : days <= 1 ? '1-day' : days <= 7 ? '7-days' : days <= 15 ? '15-days' : '30-days';
      alerts[alerts.length - 1].id += `:${stage}`;
    }
  }
  for (const ticket of active(store.tickets)) if (!['Closed', 'Resolved'].includes(ticket.status) && ticket.dueDate && ticket.dueDate < today) push('tickets', ticket, 'Ticket Overdue', 'Support resolution is overdue', 'critical', ticket.dueDate, ticket.technician);
  return alerts.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) || String(a.date).localeCompare(String(b.date)));
}

export function runAutomations(initialStore: Store, now = new Date()): { store: Store; created: number } {
  const store = structuredClone(initialStore);
  let created = 0;
  for (const alert of getAlerts(store, now)) {
    const trigger = ({ 'AMC Renewal': 'AMC Expiring', 'License Renewal': 'License Expiring', 'Low Stock': 'Low Stock', 'Payment Overdue': 'Payment Overdue', 'Project Deadline': 'Project Due' } as Record<string, string>)[alert.type];
    const rule = live(store.automations).find(r => r.trigger === trigger);
    if (rule?.enabled === false || (rule?.daysBefore !== undefined && alert.days !== undefined && alert.days > n(rule.daysBefore))) continue;
    if (!(store.notifications || []).some(r => r.automationKey === alert.id)) { addSystemRecord(store, 'notifications', { name: alert.name, message: alert.message, type: alert.type, sourceModule: alert.moduleId, sourceId: alert.recordId, recipient: alert.recipient, channel: 'In-App', date: now.toISOString().slice(0, 10), read: false, status: 'Delivered', automationKey: alert.id }); created++; }
    if (alert.type === 'AMC Renewal' && n(alert.days) >= 0 && n(alert.days) <= 30 && !live(store.automations).some(r => r.trigger === 'AMC Expiring' && r.enabled === false)) {
      const contract = get(store, 'amc', alert.recordId)!;
      const customer = get(store, 'customers', contract.customer);
      const key = `amc-renewal:${contract.id}:${contract.endDate}`;
      if (!(store.leads || []).some(r => r.automationKey === key)) { addSystemRecord(store, 'leads', { name: `${contract.name} renewal`, company: customer?.company || customer?.name, mobile: customer?.mobile || '', email: customer?.email, customer: contract.customer, city: customer?.city, source: 'Existing Customer', type: 'Renewal', budget: n(contract.amount), status: 'New', priority: 'High', expectedClosing: contract.endDate, assignedTo: rule?.assignedTo || contract.technician, requirement: 'AMC renewal', automationKey: key }); created++; }
    }
  }
  return { store: recalculate(store, now), created };
}

export function getReceivables(store: Store, now = new Date()): ERPRecord[] {
  const today = now.toISOString().slice(0, 10);
  const balances = live(store.projects).filter(r => r.status !== 'Cancelled').map(project => {
    const paid = live(store.payments).filter(r => r.project === project.id && isReceived(r)).reduce((total, payment) => total + (payment.type === 'Refund' ? -1 : 1) * n(payment.amount), 0);
    return { id: project.id, name: project.name, customer: project.customer, project: project.id, amount: n(project.value), paid, balance: round(Math.max(0, n(project.value) - paid)), dueDate: project.paymentDueDate || project.dueDate };
  }).concat(live(store.receivables).filter(r => !r.project).map(r => ({ id: r.id, name: r.name, customer: r.customer, project: '', amount: n(r.amount), paid: n(r.paid), balance: round(Math.max(0, n(r.amount) - n(r.paid))), dueDate: r.dueDate })));
  return balances.filter(r => r.balance > 0).map(r => { const daysOverdue = r.dueDate ? Math.max(0, Math.floor((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${r.dueDate}T00:00:00Z`).getTime()) / 86400000)) : 0; return { ...r, daysOverdue, ageing: daysOverdue <= 30 ? '0–30 Days' : daysOverdue <= 60 ? '31–60 Days' : daysOverdue <= 90 ? '61–90 Days' : '90+ Days', status: dateStatus(r.balance, r.paid, r.dueDate, now) }; });
}

export function getPayables(store: Store, now = new Date()): ERPRecord[] {
  const purchases = live(store.purchases).filter(r => r.status === 'Received').map(purchase => {
    const paid = sum(live(store.supplierPayments).filter(r => r.purchase === purchase.id && r.status === 'Paid'), 'amount');
    const amount = purchaseTotal(purchase), balance = round(Math.max(0, amount - paid));
    return { id: purchase.id, name: purchase.name, supplier: purchase.supplier, purchase: purchase.id, amount, paid, balance, dueDate: purchase.dueDate, status: dateStatus(balance, paid, purchase.dueDate, now) };
  });
  return [...purchases, ...live(store.payables).map(record => { const balance = round(Math.max(0, n(record.amount) - n(record.paid))); return { ...record, balance, status: dateStatus(balance, n(record.paid), record.dueDate, now) }; })].filter(record => record.balance > 0);
}

export function getCalendarEvents(store: Store): ERPRecord[] {
  return [
    ...active(store.events),
    ...active(store.followups).map(r => ({ ...r, id: `followup:${r.id}`, sourceModule: 'followups', sourceId: r.id, type: r.type || 'Follow-up', startAt: r.dueAt })),
    ...active(store.workOrders).map(r => ({ ...r, id: `work:${r.id}`, sourceModule: 'workOrders', sourceId: r.id, type: 'Installation', startAt: r.scheduledAt })),
    ...active(store.surveys).map(r => ({ ...r, id: `survey:${r.id}`, sourceModule: 'surveys', sourceId: r.id, type: 'Site Survey', startAt: r.surveyDate })),
    ...active(store.projects).filter(r => !['Completed', 'Cancelled'].includes(r.status)).map(r => ({ ...r, id: `project:${r.id}`, sourceModule: 'projects', sourceId: r.id, type: 'Project Deadline', startAt: r.dueDate })),
    ...(['amc', 'licenses', 'domains', 'hosting'] as const).flatMap(moduleId => live(store[moduleId]).filter(r => r.status !== 'Cancelled').map(r => ({ ...r, id: `renewal:${moduleId}:${r.id}`, sourceModule: moduleId, sourceId: r.id, type: `${moduleById[moduleId].singular} Renewal`, startAt: r.endDate || r.expiryDate })))
  ].filter(r => r.startAt).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
}

export function calculateMetrics(store: Store, now = new Date()) {
  const calculated = recalculate(structuredClone(store), now);
  const today = now.toISOString().slice(0, 10), month = today.slice(0, 7);
  const leads = live(calculated.leads), projects = live(calculated.projects).filter(r => r.status !== 'Cancelled'), received = live(calculated.payments).filter(isReceived), expenses = live(calculated.expenses).filter(isApproved), claims = live(calculated.employeeExpenses).filter(isApproved), income = live(calculated.income).filter(r => r.status === 'Received');
  const netPayments = (records: ERPRecord[]) => round(records.reduce((total, r) => total + (r.type === 'Refund' ? -1 : 1) * n(r.amount), 0));
  const alerts = getAlerts(calculated, now);
  const monthlyTrend = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1));
    const key = date.toISOString().slice(0, 7);
    const revenue = netPayments(received.filter(r => String(r.date).startsWith(key))) + sum(income.filter(r => String(r.date).startsWith(key)), 'amount');
    const cost = sum(expenses.concat(claims).filter(r => String(r.date).startsWith(key)), 'amount');
    return { month: date.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }), key, revenue: round(revenue), expenses: round(cost), profit: round(revenue - cost) };
  });
  const cityStats = [...new Set(projects.map(r => r.city || get(calculated, 'customers', r.customer)?.city || 'Other'))].map(city => { const subset = projects.filter(r => (r.city || get(calculated, 'customers', r.customer)?.city || 'Other') === city); return { city, projects: subset.length, revenue: sum(subset, 'value'), expenses: sum(subset, 'actualCost'), profit: sum(subset, 'profit'), leads: leads.filter(r => r.city === city).length, customers: live(calculated.customers).filter(r => r.city === city).length }; });
  const serviceStats = live(calculated.services).map(service => { const subset = projects.filter(r => r.service === service.id); const revenue = sum(subset, 'value'), cost = sum(subset, 'actualCost'); return { id: service.id, name: service.name, projects: subset.length, revenue, expenses: cost, profit: round(revenue - cost), margin: revenue ? round((revenue - cost) / revenue * 100) : 0, averageValue: subset.length ? round(revenue / subset.length) : 0 }; });
  const productStats = live(calculated.products).map(product => { const subset = live(calculated.allocations).filter(r => r.product === product.id); const units = sum(subset, 'usedQuantity'), revenue = round(units * n(product.sellingPrice)), cost = round(units * n(product.purchasePrice)); return { id: product.id, name: product.name, units, revenue, cost, profit: round(revenue - cost), margin: revenue ? round((revenue - cost) / revenue * 100) : 0, stock: sum(live(calculated.inventory).filter(r => r.product === product.id), 'available') }; });
  const salespersonStats = live(calculated.employees).filter(e => ['Sales', 'Manager', 'Admin', 'Super Admin'].includes(e.role)).map(employee => { const subset = leads.filter(r => r.assignedTo === employee.id); return { id: employee.id, name: employee.name, leads: subset.length, won: subset.filter(r => r.status === 'Won').length, conversion: subset.length ? round(subset.filter(r => r.status === 'Won').length / subset.length * 100) : 0, revenue: sum(projects.filter(r => r.salesperson === employee.id), 'value') }; });
  const technicianStats = live(calculated.employees).filter(e => e.role === 'Technician').map(employee => { const jobs = live(calculated.technicianJobs).filter(r => r.technician === employee.id); return { id: employee.id, name: employee.name, jobs: jobs.length, active: jobs.filter(r => r.status !== 'Work Completed').length, completed: jobs.filter(r => r.status === 'Work Completed').length }; });
  const revenue = sum(projects, 'value') + sum(income, 'amount');
  const costs = sum(projects, 'materialCost') + sum(expenses, 'amount') + sum(claims, 'amount');
  const receivables = getReceivables(calculated, now);
  const payables = getPayables(calculated, now);
  return {
    totalLeads: leads.length, newLeadsToday: leads.filter(r => String(r.createdAt).startsWith(today)).length, hotLeads: leads.filter(r => ['High', 'Critical'].includes(r.priority) && !['Won', 'Lost', 'Not Interested', 'Invalid Lead'].includes(r.status)).length,
    followupsDue: alerts.filter(r => r.type === 'Follow-up Due').length, leadsWon: leads.filter(r => r.status === 'Won').length, leadsLost: leads.filter(r => r.status === 'Lost').length, conversionRate: leads.length ? round(leads.filter(r => r.status === 'Won').length / leads.length * 100) : 0,
    activeProjects: projects.filter(r => !r.archivedAt && !['Completed', 'On Hold'].includes(r.status)).length, completedProjects: projects.filter(r => r.status === 'Completed').length, delayedProjects: projects.filter(r => !r.archivedAt && r.dueDate && r.dueDate < today && !['Completed', 'On Hold'].includes(r.status)).length, projectsOnHold: projects.filter(r => !r.archivedAt && r.status === 'On Hold').length, projectsAwaitingMaterial: projects.filter(r => !r.archivedAt && r.status === 'Material Procurement').length,
    upcomingSiteVisits: live(calculated.workOrders).filter(r => String(r.scheduledAt).slice(0, 10) >= today && r.status !== 'Completed').length, techniciansOnSite: live(calculated.technicianJobs).filter(r => ['Reached Site', 'Work Started'].includes(r.status)).length, openTickets: live(calculated.tickets).filter(r => !['Resolved', 'Closed'].includes(r.status)).length,
    totalSales: round(revenue), monthlyRevenue: round(netPayments(received.filter(r => String(r.date).startsWith(month))) + sum(income.filter(r => String(r.date).startsWith(month)), 'amount')), monthlyExpenses: round(sum(expenses.concat(claims).filter(r => String(r.date).startsWith(month)), 'amount')), grossProfit: round(revenue - sum(projects, 'materialCost')), netProfit: round(revenue - costs), outstandingPayments: sum(receivables, 'balance'), paymentsReceived: netPayments(received), purchaseAmount: sum(live(calculated.purchases).filter(r => r.status === 'Received'), 'total'), inventoryValue: sum(live(calculated.inventory), 'value'), lowStock: alerts.filter(r => r.type === 'Low Stock').length,
    amcRenewals: alerts.filter(r => r.type === 'AMC Renewal').length, licenseRenewals: alerts.filter(r => r.type === 'License Renewal').length, domainRenewals: alerts.filter(r => r.type === 'Domain Renewal').length, hostingRenewals: alerts.filter(r => r.type === 'Hosting Renewal').length, attendanceToday: live(calculated.attendance).filter(r => r.date === today && ['Present', 'Site Duty', 'Work From Home'].includes(r.status)).length,
    monthlyTrend, cityStats, serviceStats, productStats, salespersonStats, technicianStats, leadSources: [...new Set(leads.map(r => r.source || 'Other'))].map(source => ({ source, count: leads.filter(r => (r.source || 'Other') === source).length })), leadPipeline: [...new Set(leads.map(r => r.status || 'New'))].map(status => ({ status, count: leads.filter(r => (r.status || 'New') === status).length })), customerLifetime: live(calculated.customers).map(r => ({ id: r.id, name: r.name, revenue: r.totalRevenue, cost: r.totalCost, profit: r.lifetimeProfit, projects: r.totalProjects, balance: r.balanceDue })), recurringMRR: sum(live(calculated.recurring).filter(r => !['Expired', 'Cancelled'].includes(r.status)), 'mrr'), recurringARR: sum(live(calculated.recurring).filter(r => !['Expired', 'Cancelled'].includes(r.status)), 'arr'), receivables, payables, outstandingPayables: sum(payables, 'balance'), alerts, projects, expenses,
  };
}

export const getMetrics = calculateMetrics;
export const getRenewalReminders = (store: Store, now = new Date()) => getAlerts(store, now).filter(alert => /Renewal|Expiry/.test(alert.type));
