import type { ERPRecord, Store } from './schema.ts';

// Billing and client access retain their existing customer IDs. Leads are the
// visible company profiles; customers remain an internal compatibility ledger.
export const companyFields: Record<string, string> = {
  name: 'name', contactPerson: 'contactPersons', mobile: 'mobile', alternateMobile: 'alternateMobile',
  email: 'email', otherEmails: 'otherEmails', website: 'website', address: 'address', city: 'city',
  state: 'state', pinCode: 'pinCode', gstNumber: 'gstNumber', pan: 'pan', category: 'category',
  billingAddress: 'billingAddress', installationAddress: 'installationAddress', siteAddresses: 'siteAddresses',
  paymentTerms: 'paymentTerms', creditLimit: 'creditLimit', contactDesignation: 'contactDesignation',
  additionalContacts: 'additionalContacts',
};

export function syncLeadCompany(store: Store, lead: ERPRecord, preserveExisting = false) {
  store.customers ||= [];
  let company = store.customers.find(row => row.id === lead.customer);
  const existed = Boolean(company);
  if (!company) {
    company = { id: `CUS-LEAD-${lead.id}`, name: lead.name, status: 'Active', createdAt: lead.createdAt, demo: lead.demo };
    store.customers.push(company);
    lead.customer = company.id;
  }
  company.profileLeadId ||= lead.id;
  if (preserveExisting && existed) return company;
  for (const [key, target] of Object.entries(companyFields)) if (lead[key] !== undefined) company[target] = lead[key];
  company.company = lead.name;
  company.updatedAt = lead.updatedAt;
  // Older company forms only offered billing addresses.
  if (lead.address !== undefined && !lead.billingAddress) company.billingAddress = lead.address;
  return company;
}

export function migrateLeadProfiles(store: Store): boolean {
  const before = JSON.stringify([store.leads, store.customers]);
  store.leads ||= [];
  for (const lead of store.leads) {
    const needsMigration = !lead.profileVersion;
    if (!lead.profileVersion) {
      let existing = (store.customers || []).find(row => row.id === lead.customer);
      if (!lead.customer) {
        const normalize = (value: unknown) => String(value || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-IN');
        const name = normalize(lead.company || lead.name);
        const matches = (store.customers || []).filter(row => !row.deletedAt && !row.archivedAt && name && [row.company,row.name].some(value => normalize(value) === name)
          && (!lead.city || !row.city || normalize(lead.city) === normalize(row.city))
          && (!lead.gstNumber || !row.gstNumber || normalize(lead.gstNumber) === normalize(row.gstNumber)));
        if (matches.length === 1) { existing = matches[0]; lead.customer = existing.id; }
      }
      const name = lead.company || existing?.company || existing?.name;
      if (name && name !== lead.name) { lead.contactPerson ||= lead.name; lead.name = name; }
      if (existing) for (const [key, source] of Object.entries(companyFields)) if (key !== 'name' && lead[key] === undefined && existing[source] !== undefined) lead[key] = existing[source];
      if (existing?.contactPersons && existing.contactPersons !== lead.contactPerson) lead.additionalContacts ||= existing.contactPersons;
      lead.profileVersion = 1;
    }
    if (!lead.deletedAt && (needsMigration || !lead.customer)) syncLeadCompany(store, lead, true);
  }
  for (const company of store.customers || []) {
    // A removed profile must never be silently recreated on the next reload.
    if (company.profileLeadId || company.deletedAt || company.archivedAt) continue;
    let lead = store.leads.find(row => row.customer === company.id);
    if (!lead) {
      lead = { id: `LEA-COMPANY-${company.id}`, name: company.company || company.name, customer: company.id,
        status: 'Won', profileVersion: 1, createdAt: company.createdAt, updatedAt: company.updatedAt,
        demo: company.demo, notes: company.notes, attachments: company.attachments || [] };
      for (const [key, source] of Object.entries(companyFields)) if (key !== 'name' && company[source] !== undefined) lead[key] = company[source];
      lead.address ||= company.billingAddress;
      store.leads.push(lead);
    }
    company.profileLeadId = lead.id;
    if (!lead.deletedAt) syncLeadCompany(store, lead, true);
  }
  return before !== JSON.stringify([store.leads, store.customers]);
}

export function linkProjectCompany(store: Store, project: ERPRecord, before?: ERPRecord) {
  if (project.customer) {
    if (!project.lead || project.customer !== before?.customer) {
      project.lead = (store.leads || []).find(row => row.customer === project.customer && !row.deletedAt && !row.archivedAt)?.id;
    }
  } else if (project.lead) project.customer = (store.leads || []).find(row => row.id === project.lead)?.customer;
}
