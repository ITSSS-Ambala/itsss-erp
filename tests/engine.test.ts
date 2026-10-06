import test from 'node:test';
import assert from 'node:assert/strict';
// Native Node 24 TypeScript resolves explicit .ts extensions.
// @ts-ignore -- the app tsconfig may not enable allowImportingTsExtensions.
import { applyMutation, validateRecord, calculateMetrics, getReceivables, getCalendarEvents, runAutomations } from '../lib/engine.ts';
// @ts-ignore -- native Node TypeScript import.
import { modules, type Store, type ERPRecord } from '../lib/schema.ts';

const today = '2026-10-06';

function fresh(): Store {
  const store: Store = Object.fromEntries(modules.map(module => [module.id, []]));
  store.customers = [
    { id: 'customer-a', name: 'Aster Retail', mobile: '9876543210', email: 'accounts@aster.example', city: 'Ambala', status: 'Active' },
    { id: 'customer-b', name: 'Beacon Hospital', mobile: '9876543211', email: 'admin@beacon.example', city: 'Chandigarh', status: 'Active' },
  ];
  store.products = [{ id: 'product-a', sku: 'CAM-001', name: 'IP Camera', purchasePrice: 200, sellingPrice: 350, minimumStock: 2, gstRate: 18, status: 'Active' }];
  store.services = [{ id: 'service-a', name: 'CCTV Installation', category: 'CCTV', standardPrice: 1000, status: 'Active' }];
  store.employees = [{ id: 'employee-a', name: 'Dev Singh', role: 'Technician', department: 'Technical', status: 'Active' }];
  store.suppliers = [{ id: 'supplier-a', name: 'Camera Supplier', status: 'Active' }];
  store.projects = [{ id: 'project-a', name: 'Aster CCTV', customer: 'customer-a', value: 10000, estimatedCost: 2000, status: 'Planning', service: 'service-a', city: 'Ambala' }];
  store.inventory = [{ id: 'stock-a', name: 'Camera warehouse', product: 'product-a', location: 'Warehouse', quantity: 20, reserved: 0, damaged: 0, returned: 0, unitCost: 200 }];
  store.settings = [{ id: 'company', name: 'ITSSS', currency: 'INR' }];
  return store;
}

function mutate(store: Store, moduleId: string, action: 'create' | 'update' | 'delete' | 'restore' | 'duplicate', data: Record<string, unknown> = {}, id?: string) {
  return applyMutation(store, moduleId, action, data, id, 'Test reviewer');
}

function active(store: Store, moduleId: string): ERPRecord[] {
  return (store[moduleId] || []).filter(record => !record.deletedAt && !record.archivedAt);
}

const leadData = (overrides: Record<string, unknown> = {}) => ({ name: 'New prospect', mobile: '9876543222', company: 'New prospect company', city: 'Mohali', address: '10 Sector Road', budget: 12000, service: 'service-a', status: 'New', ...overrides });
const paymentData = (amount: number, overrides: Record<string, unknown> = {}) => ({ name: `Receipt ${amount}`, customer: 'customer-a', project: 'project-a', amount, date: today, method: 'UPI', status: 'Received', ...overrides });
const transferData = (quantity: number, overrides: Record<string, unknown> = {}) => ({ name: `Transfer ${quantity}`, product: 'product-a', fromLocation: 'Warehouse', toLocation: 'Office', quantity, date: today, status: 'Completed', ...overrides });
const allocationData = (quantity: number, overrides: Record<string, unknown> = {}) => ({ name: `Allocation ${quantity}`, product: 'product-a', project: 'project-a', technician: 'employee-a', location: 'Warehouse', quantity, usedQuantity: 0, returnedQuantity: 0, wastage: 0, date: today, approvalStatus: 'Approved', status: 'Reserved', ...overrides });
const expenseData = (amount: number, overrides: Record<string, unknown> = {}) => ({ name: 'Technician travel', project: 'project-a', date: today, category: 'Travel', amount, gst: 0, approvalStatus: 'Approved', status: 'Approved', ...overrides });

test('a lead first saved as Won creates a linked customer, site and project', () => {
  const initial = fresh();
  const result = mutate(initial, 'leads', 'create', leadData({ status: 'Won' }));
  const lead = result.record;
  assert.ok(lead.customer, 'won lead has a customer reference');
  assert.ok(lead.project, 'won lead has a project reference');
  assert.ok(active(result.store, 'customers').some(customer => customer.id === lead.customer));
  const project = active(result.store, 'projects').find(project => project.id === lead.project);
  assert.ok(project, 'linked project exists');
  assert.equal(project.customer, lead.customer);
  assert.equal(project.value, 12000);
  assert.ok(active(result.store, 'sites').some(site => site.customer === lead.customer), 'customer has an installation site');
});

test('changing a lead to Won again never duplicates its customer, site or project', () => {
  let result = mutate(fresh(), 'leads', 'create', leadData());
  const leadId = result.record.id;
  result = mutate(result.store, 'leads', 'update', { status: 'Won' }, leadId);
  const customerId = result.record.customer;
  const projectId = result.record.project;
  const counts = ['customers', 'sites', 'projects'].map(moduleId => active(result.store, moduleId).length);
  result = mutate(result.store, 'leads', 'update', { status: 'Won', notes: 'Confirmed again' }, leadId);
  assert.equal(result.record.customer, customerId);
  assert.equal(result.record.project, projectId);
  assert.deepEqual(['customers', 'sites', 'projects'].map(moduleId => active(result.store, moduleId).length), counts);
  result = mutate(result.store, 'leads', 'update', { status: 'Negotiation' }, leadId);
  result = mutate(result.store, 'leads', 'update', { status: 'Won' }, leadId);
  assert.deepEqual(['customers', 'sites', 'projects'].map(moduleId => active(result.store, moduleId).length), counts);
});

test('required fields, email, numbers and relations are validated before persistence', () => {
  const store = fresh();
  assert.ok(validateRecord('leads', { name: '', mobile: '' }, store).length > 0);
  assert.ok(validateRecord('leads', leadData({ email: 'invalid-address' }), store).length > 0);
  assert.ok(validateRecord('projects', { name: 'Invalid project', value: Number.NaN }, store).length > 0);
  assert.ok(validateRecord('payments', paymentData(100, { customer: 'missing-customer' }), store).length > 0);
  assert.ok(validateRecord('payments', paymentData(100, { date: '2026-02-30' }), store).length > 0, 'impossible calendar dates are rejected');
  assert.throws(() => mutate(store, 'leads', 'create', leadData({ email: 'invalid-address' })));
  assert.equal(store.leads.length, 0, 'failed validation leaves the input unchanged');
});

test('duplicate SKU is rejected while editing the same product is valid', () => {
  const store = fresh();
  assert.throws(() => mutate(store, 'products', 'create', { sku: 'CAM-001', name: 'Duplicate camera' }));
  const result = mutate(store, 'products', 'update', { name: 'Renamed camera' }, 'product-a');
  assert.equal(result.record.sku, 'CAM-001');
  assert.equal(result.record.name, 'Renamed camera');
});

test('a completed stock transfer preserves total stock and posts only once', () => {
  let result = mutate(fresh(), 'stockTransfers', 'create', transferData(6));
  const warehouse = result.store.inventory.find(stock => stock.product === 'product-a' && stock.location === 'Warehouse');
  const office = result.store.inventory.find(stock => stock.product === 'product-a' && stock.location === 'Office');
  assert.equal(warehouse?.quantity, 14);
  assert.equal(office?.quantity, 6);
  const transferId = result.record.id;
  result = mutate(result.store, 'stockTransfers', 'update', { notes: 'Arrived safely', status: 'Completed' }, transferId);
  assert.equal(result.store.inventory.find(stock => stock.location === 'Warehouse')?.quantity, 14);
  assert.equal(result.store.inventory.find(stock => stock.location === 'Office')?.quantity, 6);
});

test('stock transfers reject shortages, nonpositive amounts and the same location', () => {
  const store = fresh();
  for (const quantity of [21, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mutate(store, 'stockTransfers', 'create', transferData(quantity)), `quantity ${quantity} is rejected`);
  }
  assert.throws(() => mutate(store, 'stockTransfers', 'create', transferData(2, { toLocation: 'Warehouse' })));
  assert.equal(store.inventory[0].quantity, 20);
  assert.equal(store.stockTransfers.length, 0);
});

test('material reservation reduces available stock and cannot be oversubscribed', () => {
  const result = mutate(fresh(), 'allocations', 'create', allocationData(12));
  const stock = result.store.inventory.find(stock => stock.id === 'stock-a');
  assert.equal(stock?.quantity, 20);
  assert.equal(stock?.reserved, 12);
  assert.equal(stock?.available, 8);
  assert.throws(() => mutate(result.store, 'allocations', 'create', allocationData(9, { name: 'Over reservation' })));
  assert.throws(() => mutate(result.store, 'stockTransfers', 'create', transferData(9)));
});

test('material use and waste cannot exceed the reservation', () => {
  const result = mutate(fresh(), 'allocations', 'create', allocationData(5));
  assert.throws(() => mutate(result.store, 'allocations', 'update', { usedQuantity: 6, status: 'Used' }, result.record.id));
  assert.throws(() => mutate(result.store, 'allocations', 'update', { usedQuantity: 4, wastage: 2, status: 'Used' }, result.record.id));
  assert.throws(() => mutate(result.store, 'allocations', 'update', { returnedQuantity: 6, status: 'Returned' }, result.record.id));
  assert.equal(result.store.inventory[0].quantity, 20);
});

test('approved project expenses recalculate costs and profit on edit, delete and restore', () => {
  let result = mutate(fresh(), 'expenses', 'create', expenseData(1000));
  const expenseId = result.record.id;
  const project = () => result.store.projects.find(project => project.id === 'project-a')!;
  assert.equal(project().actualCost, 1000);
  assert.equal(project().profit, 9000);
  assert.equal(project().margin, 90);
  result = mutate(result.store, 'expenses', 'update', { amount: 1500 }, expenseId);
  assert.equal(project().actualCost, 1500);
  assert.equal(project().profit, 8500);
  result = mutate(result.store, 'expenses', 'delete', { deletionReason: 'Duplicate claim' }, expenseId);
  assert.equal(project().actualCost, 0);
  assert.equal(project().profit, 10000);
  result = mutate(result.store, 'expenses', 'restore', {}, expenseId);
  assert.equal(project().actualCost, 1500);
  assert.equal(project().profit, 8500);
});

test('pending and rejected expenses do not enter approved project costs', () => {
  let result = mutate(fresh(), 'expenses', 'create', expenseData(400, { approvalStatus: 'Pending', status: 'Submitted' }));
  assert.equal(result.store.projects[0].actualCost, 0);
  result = mutate(result.store, 'expenses', 'update', { approvalStatus: 'Rejected', status: 'Rejected' }, result.record.id);
  assert.equal(result.store.projects[0].actualCost, 0);
});

test('partial payments can settle a project exactly and further payments are rejected', () => {
  let result = mutate(fresh(), 'payments', 'create', paymentData(4000));
  assert.equal(result.store.projects[0].paidAmount, 4000);
  assert.equal(result.store.projects[0].balanceDue, 6000);
  result = mutate(result.store, 'payments', 'create', paymentData(6000, { name: 'Final receipt' }));
  assert.equal(active(result.store, 'payments').reduce((sum, payment) => sum + Number(payment.amount), 0), 10000);
  assert.equal(result.store.projects[0].paidAmount, 10000);
  assert.equal(result.store.projects[0].balanceDue, 0);
  assert.throws(() => mutate(result.store, 'payments', 'create', paymentData(1, { name: 'Excess receipt' })));
});

test('payments reject excess amounts, nonpositive values and a mismatched project customer', () => {
  const store = fresh();
  for (const amount of [10001, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mutate(store, 'payments', 'create', paymentData(amount)), `payment ${amount} is rejected`);
  }
  assert.throws(() => mutate(store, 'payments', 'create', paymentData(100, { customer: 'customer-b' })));
  assert.equal(store.payments.length, 0);
});

test('editing a payment validates against other receipts without double counting itself', () => {
  let result = mutate(fresh(), 'payments', 'create', paymentData(4000));
  const paymentId = result.record.id;
  result = mutate(result.store, 'payments', 'create', paymentData(3000, { name: 'Second receipt' }));
  result = mutate(result.store, 'payments', 'update', { amount: 7000 }, paymentId);
  assert.equal(result.record.amount, 7000);
  assert.throws(() => mutate(result.store, 'payments', 'update', { amount: 7001 }, paymentId));
});

test('deleting and restoring a payment updates project balance', () => {
  let result = mutate(fresh(), 'payments', 'create', paymentData(2500));
  const paymentId = result.record.id;
  result = mutate(result.store, 'payments', 'delete', { deletionReason: 'Pending review' }, paymentId);
  assert.equal(result.store.projects[0].paidAmount, 0);
  assert.equal(result.store.projects[0].balanceDue, 10000);
  result = mutate(result.store, 'payments', 'restore', {}, paymentId);
  assert.equal(result.store.projects[0].paidAmount, 2500);
  assert.equal(result.store.projects[0].balanceDue, 7500);
});

test('goods receipts add stock exactly once and deletion/restoration reconciles inventory', () => {
  let result = mutate(fresh(), 'purchases', 'create', { name: 'Delivery 1', product: 'product-a', supplier: 'supplier-a', quantity: 5, rate: 200, gstRate: 18, date: today, location: 'Warehouse', status: 'Received' });
  const purchaseId = result.record.id;
  assert.equal(result.record.total, 1180);
  assert.equal(result.store.inventory.find(stock => stock.id === 'stock-a')?.quantity, 25);
  result = mutate(result.store, 'purchases', 'update', { status: 'Received', notes: 'Checked serials' }, purchaseId);
  assert.equal(result.store.inventory.find(stock => stock.id === 'stock-a')?.quantity, 25);
  result = mutate(result.store, 'purchases', 'delete', { deletionReason: 'Wrong receipt' }, purchaseId);
  assert.equal(result.store.inventory.find(stock => stock.id === 'stock-a')?.quantity, 20);
  result = mutate(result.store, 'purchases', 'restore', {}, purchaseId);
  assert.equal(result.store.inventory.find(stock => stock.id === 'stock-a')?.quantity, 25);
});

test('deleting a completed transfer reverses its ledger without changing total stock', () => {
  let result = mutate(fresh(), 'stockTransfers', 'create', transferData(6));
  const transferId = result.record.id;
  result = mutate(result.store, 'stockTransfers', 'delete', { deletionReason: 'Cancelled dispatch' }, transferId);
  assert.equal(result.store.inventory.find(stock => stock.location === 'Warehouse')?.quantity, 20);
  assert.equal(result.store.inventory.find(stock => stock.location === 'Office')?.quantity, 0);
  result = mutate(result.store, 'stockTransfers', 'restore', {}, transferId);
  assert.equal(result.store.inventory.find(stock => stock.location === 'Warehouse')?.quantity, 14);
  assert.equal(result.store.inventory.find(stock => stock.location === 'Office')?.quantity, 6);
});

test('allocation consumption charges material cost and cancellation releases reservations', () => {
  let result = mutate(fresh(), 'allocations', 'create', allocationData(6));
  const allocationId = result.record.id;
  result = mutate(result.store, 'allocations', 'update', { status: 'Used', usedQuantity: 4, wastage: 1, returnedQuantity: 1 }, allocationId);
  const stock = result.store.inventory.find(stock => stock.id === 'stock-a')!;
  assert.equal(stock.quantity, 15);
  assert.equal(stock.reserved, 0);
  assert.equal(stock.available, 15);
  assert.equal(result.store.projects[0].materialCost, 1000);
  assert.equal(result.store.projects[0].actualCost, 1000);
  const cancelled = mutate(fresh(), 'allocations', 'create', allocationData(6));
  const released = mutate(cancelled.store, 'allocations', 'update', { status: 'Cancelled' }, cancelled.record.id);
  assert.equal(released.store.inventory[0].reserved, 0);
  assert.equal(released.store.inventory[0].available, 20);
});

test('soft deletion and restoration retain identity and audit the operation', () => {
  let result = mutate(fresh(), 'leads', 'create', leadData());
  const leadId = result.record.id;
  result = mutate(result.store, 'leads', 'delete', { deletionReason: 'Entered twice' }, leadId);
  assert.equal(active(result.store, 'leads').length, 0);
  const deleted = result.store.leads.find(lead => lead.id === leadId)!;
  assert.ok(deleted.deletedAt);
  assert.ok(deleted.deletedBy);
  result = mutate(result.store, 'leads', 'restore', {}, leadId);
  assert.equal(active(result.store, 'leads').length, 1);
  assert.equal(result.record.id, leadId);
  assert.ok(result.store.auditLogs.some(event => event.module === 'leads' && event.action === 'delete'));
  assert.ok(result.store.auditLogs.some(event => event.module === 'leads' && event.action === 'restore'));
});

test('each accepted mutation records the actor and old/new values', () => {
  const created = mutate(fresh(), 'leads', 'create', leadData());
  const updated = mutate(created.store, 'leads', 'update', { status: 'Contacted' }, created.record.id);
  const audit = updated.store.auditLogs.find(event => event.recordId === created.record.id && event.action === 'update');
  assert.ok(audit);
  assert.equal(audit.actor, 'Test reviewer');
  assert.ok(audit.oldValue);
  assert.ok(audit.newValue);
  assert.ok(updated.store.activities.some(event => event.recordId === created.record.id));
});

test('a refund reduces receipts, restores the balance, and cannot exceed receipts', () => {
  let result = mutate(fresh(), 'payments', 'create', paymentData(1000));
  result = mutate(result.store, 'payments', 'create', paymentData(400, { name: 'Partial refund', type: 'Refund' }));
  assert.equal(result.store.projects[0].paidAmount, 600);
  assert.equal(result.store.projects[0].balanceDue, 9400);
  assert.throws(() => mutate(result.store, 'payments', 'create', paymentData(601, { name: 'Excess refund', type: 'Refund' })));
  result = mutate(result.store, 'payments', 'create', paymentData(9400, { name: 'Resettlement' }));
  assert.equal(result.store.projects[0].balanceDue, 0);
});

test('INR decimal sums are rounded to paise in project balance and metrics', () => {
  const store = fresh();
  store.projects[0].value = 1;
  let result = mutate(store, 'payments', 'create', paymentData(0.1));
  result = mutate(result.store, 'payments', 'create', paymentData(0.2, { name: 'Small second receipt' }));
  assert.equal(result.store.projects[0].paidAmount, 0.3);
  assert.equal(result.store.projects[0].balanceDue, 0.7);
  const metrics = calculateMetrics(result.store, new Date('2026-10-06T12:00:00Z'));
  assert.equal(metrics.paymentsReceived, 0.3);
  assert.equal(metrics.monthlyRevenue, 0.3);
});

test('cancelled payments and pending expenses stay out of financial reports', () => {
  let result = mutate(fresh(), 'payments', 'create', paymentData(500, { status: 'Cancelled' }));
  result = mutate(result.store, 'payments', 'create', paymentData(1000));
  result = mutate(result.store, 'expenses', 'create', expenseData(700, { approvalStatus: 'Pending', status: 'Submitted' }));
  result = mutate(result.store, 'expenses', 'create', expenseData(200));
  const metrics = calculateMetrics(result.store, new Date('2026-10-06T12:00:00Z'));
  assert.equal(metrics.monthlyRevenue, 1000);
  assert.equal(metrics.monthlyExpenses, 200);
  assert.equal(metrics.outstandingPayments, 9000);
});

test('project completion creates only one customer handover follow-up', () => {
  let result = mutate(fresh(), 'projects', 'update', { status: 'Completed' }, 'project-a');
  assert.equal(result.record.progress, 100);
  assert.ok(result.record.completedDate);
  assert.equal(active(result.store, 'followups').filter(followup => followup.project === 'project-a').length, 1);
  result = mutate(result.store, 'projects', 'update', { status: 'Completed', notes: 'Accepted' }, 'project-a');
  assert.equal(active(result.store, 'followups').filter(followup => followup.project === 'project-a').length, 1);
});

test('AMC expiry automation creates one renewal lead and avoids duplicate daily alerts', () => {
  const store = fresh();
  store.amc = [{ id: 'amc-a', name: 'Aster annual AMC', customer: 'customer-a', startDate: '2025-10-20', endDate: '2026-10-20', amount: 6000, visits: 4, visitsCompleted: 2, technician: 'employee-a', status: 'Active' }];
  const now = new Date('2026-10-06T12:00:00Z');
  const first = runAutomations(store, now);
  const renewal = active(first.store, 'leads').filter(lead => lead.type === 'Renewal');
  assert.equal(renewal.length, 1);
  assert.equal(renewal[0].customer, 'customer-a');
  assert.equal(renewal[0].budget, 6000);
  assert.ok(active(first.store, 'notifications').some(notification => notification.type === 'AMC Renewal'));
  const second = runAutomations(first.store, now);
  assert.equal(second.created, 0);
  assert.equal(active(second.store, 'leads').length, 1);
  const tomorrow = runAutomations(second.store, new Date('2026-10-07T12:00:00Z'));
  assert.equal(active(tomorrow.store, 'leads').length, 1);
});

test('new support tickets are assigned to the site technician', () => {
  const store = fresh();
  store.sites = [{ id: 'site-a', name: 'Aster store', customer: 'customer-a', technician: 'employee-a', status: 'Active' }];
  const result = mutate(store, 'tickets', 'create', { name: 'TKT-001', customer: 'customer-a', site: 'site-a', issue: 'Camera offline', status: 'Open', priority: 'High' });
  assert.equal(result.record.technician, 'employee-a');
  assert.equal(result.record.status, 'Assigned');
});

test('receivables ageing uses the correct 30/60/90 day boundaries', () => {
  const store = fresh();
  const now = new Date('2026-10-06T12:00:00Z');
  store.projects = [0, 30, 31, 60, 61, 90, 91].map(days => ({ id: `project-${days}`, name: `Age ${days}`, customer: 'customer-a', value: 100, status: 'Planning', paymentDueDate: new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10) }));
  const rows = getReceivables(store, now);
  const bucket = (days: number) => rows.find(row => row.id === `project-${days}`)?.ageing;
  assert.equal(bucket(0), '0–30 Days');
  assert.equal(bucket(30), '0–30 Days');
  assert.equal(bucket(31), '31–60 Days');
  assert.equal(bucket(60), '31–60 Days');
  assert.equal(bucket(61), '61–90 Days');
  assert.equal(bucket(90), '61–90 Days');
  assert.equal(bucket(91), '90+ Days');
});

test('calendar includes linked follow-ups, surveys, jobs, deadlines and renewals', () => {
  const store = fresh();
  store.followups = [{ id: 'followup-a', name: 'Call client', dueAt: '2026-10-07T10:00', type: 'Phone Call', status: 'Scheduled' }];
  store.surveys = [{ id: 'survey-a', name: 'Survey store', surveyDate: '2026-10-08', status: 'Scheduled' }];
  store.workOrders = [{ id: 'work-a', name: 'Install cameras', scheduledAt: '2026-10-09T09:00', status: 'Scheduled' }];
  store.projects[0].dueDate = '2026-10-10';
  store.amc = [{ id: 'amc-a', name: 'AMC', endDate: '2026-10-20', status: 'Active' }];
  const events = getCalendarEvents(store);
  for (const moduleId of ['followups', 'surveys', 'workOrders', 'projects', 'amc']) assert.ok(events.some(event => event.sourceModule === moduleId));
  assert.equal(events[0].startAt, '2026-10-07T10:00');
});

test('payroll and sales commissions calculate earnings and deductions', () => {
  let result = mutate(fresh(), 'payroll', 'create', { name: 'October salary', employee: 'employee-a', month: '2026-10', salary: 30000, bonus: 1000, incentives: 500, reimbursements: 200, deductions: 700, advances: 1000, status: 'Pending' });
  assert.equal(result.record.netSalary, 30000);
  result = mutate(result.store, 'commissions', 'create', { name: 'CCTV sale commission', salesperson: 'employee-a', project: 'project-a', type: 'Percentage', percentage: 5, status: 'Pending' });
  assert.equal(result.record.amount, 500);
  assert.throws(() => mutate(result.store, 'payroll', 'create', { name: 'Invalid month', employee: 'employee-a', month: '2026-13', salary: 30000 }));
});

test('custom fields and modules validate persisted schemas and options', () => {
  let result = mutate(fresh(), 'customModules', 'create', { name: 'IT Audits', moduleId: 'itAudits', singular: 'IT Audit', group: 'Custom', statuses: 'Draft\nCompleted', status: 'Active' });
  result = mutate(result.store, 'customFields', 'create', { name: 'Audit score', moduleId: 'itAudits', key: 'score', type: 'number', required: true, status: 'Active' });
  assert.throws(() => mutate(result.store, 'itAudits', 'create', { name: 'Warehouse audit', status: 'Draft' }));
  result = mutate(result.store, 'itAudits', 'create', { name: 'Warehouse audit', status: 'Draft', score: 90 });
  assert.equal(result.record.score, 90);
  assert.throws(() => mutate(result.store, 'itAudits', 'update', { status: 'Unsupported' }, result.record.id));
  assert.throws(() => mutate(result.store, 'customFields', 'create', { name: 'Unsafe field', moduleId: 'itAudits', key: '__proto__', type: 'text' }));
});

test('system histories reject direct edits, deletes and fabricated entries', () => {
  const result = mutate(fresh(), 'leads', 'create', leadData());
  for (const moduleId of ['auditLogs', 'activities', 'stockHistory']) {
    assert.throws(() => mutate(result.store, moduleId, 'create', { name: 'Fabricated event' }));
    if (result.store[moduleId].length) assert.throws(() => mutate(result.store, moduleId, 'delete', {}, result.store[moduleId][0].id));
  }
});

test('duplicating posted stock and payment records creates safe drafts without reposting', () => {
  let result = mutate(fresh(), 'stockTransfers', 'create', transferData(4));
  const transferId = result.record.id;
  result = mutate(result.store, 'stockTransfers', 'duplicate', {}, transferId);
  assert.equal(result.record.status, 'Draft');
  assert.equal(result.store.inventory.find(stock => stock.location === 'Warehouse')?.quantity, 16);
  result = mutate(result.store, 'payments', 'create', paymentData(1000));
  const paymentId = result.record.id;
  result = mutate(result.store, 'payments', 'duplicate', {}, paymentId);
  assert.equal(result.record.status, 'Pending');
  assert.equal(result.store.projects[0].paidAmount, 1000);
});

test('changing a catalogue purchase price preserves already consumed project material costs', () => {
  let result = mutate(fresh(), 'allocations', 'create', allocationData(5, { usedQuantity: 5, status: 'Used' }));
  assert.equal(result.store.projects[0].materialCost, 1000);
  result = mutate(result.store, 'products', 'update', { purchasePrice: 300 }, 'product-a');
  assert.equal(result.store.projects[0].materialCost, 1000, 'historic consumption retains its captured unit cost');
  assert.equal(result.store.projects[0].profit, 9000);
});

test('annual recurring revenue is annualized before monthly rounding', () => {
  let result = mutate(fresh(), 'recurring', 'create', { name: 'Annual hosting', customer: 'customer-a', cycle: 'Annual', amount: 1000, status: 'Active' });
  assert.equal(result.record.mrr, 83.33);
  assert.equal(result.record.arr, 1000);
  result = mutate(result.store, 'recurring', 'create', { name: 'Quarterly maintenance', customer: 'customer-a', cycle: 'Quarterly', amount: 1200, status: 'Active' });
  assert.equal(result.record.mrr, 400);
  assert.equal(result.record.arr, 4800);
});

test('archiving a payment preserves its economic balance and restore unarchives it', () => {
  let result = mutate(fresh(), 'payments', 'create', paymentData(2500));
  const paymentId = result.record.id;
  result = applyMutation(result.store, 'payments', 'archive', {}, paymentId, 'Test reviewer');
  assert.ok(result.record.archivedAt);
  assert.equal(result.store.projects[0].paidAmount, 2500);
  assert.equal(result.store.projects[0].balanceDue, 7500);
  result = mutate(result.store, 'payments', 'restore', {}, paymentId);
  assert.equal(result.record.archivedAt, undefined);
  assert.equal(result.store.projects[0].paidAmount, 2500);
});

test('permanent deletion requires recycle-bin state and refuses referenced records', () => {
  let result = mutate(fresh(), 'leads', 'create', leadData());
  const leadId = result.record.id;
  assert.throws(() => applyMutation(result.store, 'leads', 'permanentDelete', {}, leadId, 'Test reviewer'));
  result = mutate(result.store, 'leads', 'delete', {}, leadId);
  result = applyMutation(result.store, 'leads', 'permanentDelete', {}, leadId, 'Test reviewer');
  assert.equal(result.store.leads.some(lead => lead.id === leadId), false);
  result = mutate(result.store, 'customers', 'delete', {}, 'customer-a');
  assert.throws(() => applyMutation(result.store, 'customers', 'permanentDelete', {}, 'customer-a', 'Test reviewer'));
});

test('custom formulas evaluate arithmetic and reject executable expressions', () => {
  let result = mutate(fresh(), 'customModules', 'create', { name: 'IT Audits', moduleId: 'itAudits', singular: 'IT Audit', status: 'Active' });
  result = mutate(result.store, 'customFields', 'create', { name: 'Score', moduleId: 'itAudits', key: 'score', type: 'number', required: true, status: 'Active' });
  result = mutate(result.store, 'customFields', 'create', { name: 'Weighted score', moduleId: 'itAudits', key: 'weighted', type: 'formula', formula: 'score * 2 + 5', status: 'Active' });
  result = mutate(result.store, 'itAudits', 'create', { name: 'Office audit', score: 90 });
  assert.equal(result.record.weighted, 185);
  assert.throws(() => mutate(result.store, 'customFields', 'create', { name: 'Unsafe formula', moduleId: 'itAudits', key: 'unsafe', type: 'formula', formula: 'globalThis.process.exit(1)', status: 'Active' }));
});
