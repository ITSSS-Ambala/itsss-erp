import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateProjectPost, updateProjectProgress, validateProjectMediaReferences } from '../lib/project-posts.ts';
import { canDownloadFile, canViewRecord, hiddenFields, permit, projectCapabilities, projectCapabilitiesFor, visibleStore, type AccessUser } from '../lib/access.ts';
import { validateRecord } from '../lib/engine.ts';
import { modules, type Store } from '../lib/schema.ts';

const admin: AccessUser = { userId: 'admin-user', displayName: 'Administrator', role: 'Super Admin' };
const technician: AccessUser = { userId: 'tech-user', displayName: 'Installer', role: 'Technician', employee: 'tech-a' };
const client: AccessUser = { userId: 'client-user', displayName: 'Customer colleague', role: 'Client', customer: 'customer-a' };
const sales: AccessUser = { userId: 'sales-user', displayName: 'Sales colleague', role: 'Sales' };
const viewer: AccessUser = { userId: 'viewer-user', displayName: 'Observer', role: 'Viewer' };
const file = { key: 'files/photo-id/installation.png', name: 'Installation.png', type: 'image/png', size: 1200, url: '/api/files?key=files%2Fphoto-id%2Finstallation.png' };
function fixture(): Store {
  const store: Store = Object.fromEntries(modules.map(module => [module.id, []]));
  store.roles = [
    { id: 'admin-role', name: 'Super Admin', permissions: ['View', 'Add', 'Edit', 'Delete', 'Download'], allowedModules: '*', status: 'Active' },
    { id: 'tech-role', name: 'Technician', permissions: ['View', 'Add', 'Edit', 'Download'], allowedModules: 'projects,sites,employees,customers,technicianJobs,tasks', status: 'Active' },
    { id: 'client-role', name: 'Client', permissions: ['View', 'Download'], allowedModules: 'projects,customers,sites', status: 'Active' },
    { id: 'sales-role', name: 'Sales', permissions: ['View', 'Add', 'Edit', 'Delete', 'Download'], allowedModules: 'projects,sites,customers,employees', status: 'Active' },
    { id: 'viewer-role', name: 'Viewer', permissions: ['View', 'Download'], allowedModules: 'projects,settings', status: 'Active' },
  ];
  store.customers = [{ id: 'customer-a', name: 'Own customer', status: 'Active' }, { id: 'customer-b', name: 'Other customer', status: 'Active' }];
  store.employees = [{ id: 'tech-a', name: 'Installer', status: 'Active', role: 'Technician' }, { id: 'tech-b', name: 'Other installer', status: 'Active', role: 'Technician' }];
  store.sites = [{ id: 'site-a', name: 'Assigned site', customer: 'customer-a', technician: 'tech-a', status: 'Active' }, { id: 'site-b', name: 'Other site', customer: 'customer-b', technician: 'tech-b', status: 'Active' }];
  store.projects = [{ id: 'project-a', name: 'Camera installation', customer: 'customer-a', site: 'site-a', value: 10000, status: 'Planning', progress: 0 }, { id: 'project-b', name: 'Other installation', customer: 'customer-b', site: 'site-b', value: 20000, status: 'Planning', progress: 0 }];
  store.settings = [{ id: 'company', name: 'ITSSS', logo: [{ key: 'files/logo-id/brand.png', type: 'image/png', size: 1200 }] }];
  return store;
}
const post = (store: Store, user: AccessUser = technician, data: Record<string, unknown> = {}) => mutateProjectPost(store, user, 'create', { project: 'project-a', kind: 'Comment', body: 'Installation details', media: [], ...data });
const uploadMetadata = (user = technician, projectId = 'project-a') => ({ module: 'projectPosts', projectId, creatorId: user.userId, uploadedAt: new Date().toISOString(), name: 'Installation.png' });

test('an installer assigned only to a site can view its linked project and timeline', () => {
  const store = fixture();
  assert.equal(canViewRecord(store, technician, 'projects', store.projects[0]), true);
  assert.equal(canViewRecord(store, technician, 'projects', store.projects[1]), false);
  assert.deepEqual(projectCapabilities(store, technician, 'project-a'), { post: true, updateProgress: true, managePosts: false });
  const created = post(store);
  assert.equal(visibleStore(created.store, technician).projectPosts[0].id, created.record.id);
  assert.equal(projectCapabilitiesFor(store, technician)['project-b'], undefined);
});

test('assignment revocation immediately removes project visibility, posting and media access', () => {
  const created = post(fixture(), technician, { media: [file] });
  created.store.sites[0].technician = 'tech-b';
  assert.equal(canViewRecord(created.store, technician, 'projects', created.store.projects[0]), false);
  assert.deepEqual(projectCapabilities(created.store, technician, 'project-a'), { post: false, updateProgress: false, managePosts: false });
  assert.equal(visibleStore(created.store, technician).projectPosts.length, 0);
  assert.throws(() => post(created.store), /FORBIDDEN/);
  assert.equal(canDownloadFile(created.store, technician, file.key, uploadMetadata()), false);
});

test('creation stamps trusted authorship and time while preserving the input store', () => {
  const store = fixture(), before = structuredClone(store);
  const created = mutateProjectPost(store, technician, 'create', { project: 'project-a', kind: 'Comment', body: 'Installed rack' }, undefined, { id: 'spoofed-actor', name: 'Fake actor', role: 'Admin', device: 'Browser' });
  assert.equal(created.record.authorId, technician.userId);
  assert.equal(created.record.authorName, technician.displayName);
  assert.equal(created.record.authorRole, technician.role);
  assert.ok(Number.isFinite(new Date(created.record.postedAt).getTime()));
  assert.equal(created.record.createdById, technician.userId);
  assert.deepEqual(store, before);
  assert.equal(JSON.parse(created.store.auditLogs.at(-1)!.newValue).authorId, technician.userId);
});

test('an update and its project progress commit together without financial write access', () => {
  const store = fixture();
  assert.equal(permit(technician.role, 'projects', 'edit', store), false);
  assert.ok(hiddenFields(store, technician, 'projects').has('value'));
  const created = post(store, technician, { kind: 'Update', body: 'Cabling complete', progress: 45, stage: 'Installation In Progress' });
  assert.equal(created.store.projects[0].progress, 45);
  assert.equal(created.store.projects[0].status, 'Installation In Progress');
  assert.equal(created.store.projects[0].value, 10000);
  assert.equal(created.record.progress, 45);
  assert.equal(created.store.auditLogs.filter(row => row.module === 'projects').length, 1);
});

test('invalid post content cannot leave a partial project progress change', () => {
  const store = fixture(), before = structuredClone(store);
  assert.throws(() => post(store, technician, { kind: 'Update', progress: 40, body: ' ', media: [] }), /comment, details/);
  assert.deepEqual(store, before);
  assert.throws(() => post(store, technician, { kind: 'Update', progress: 40, parent: 'missing' }), /Reply to/);
  assert.deepEqual(store, before);
});

test('safe progress mutation accepts only finite numbers and configured stages', () => {
  const store = fixture();
  assert.equal(updateProjectProgress(store, technician, 'project-a', { progress: 30 }).record.progress, 30);
  for (const value of [-1, 101, NaN, Infinity, '30', null]) assert.throws(() => updateProjectProgress(store, technician, 'project-a', { progress: value }), /number between/);
  assert.throws(() => updateProjectProgress(store, technician, 'project-a', { stage: 'Unsaved custom stage' }), /configured project stage/);
  assert.throws(() => updateProjectProgress(store, technician, 'project-a', { value: 1, progress: 50 }), /Only project progress/);
  assert.throws(() => updateProjectProgress(store, technician, 'project-a', {}), /Provide project progress/);
  assert.throws(() => updateProjectProgress(store, technician, 'project-b', { progress: 50 }), /FORBIDDEN/);
});

test('completed updates normalize progress to 100 and trigger one handover follow-up', () => {
  const created = post(fixture(), technician, { kind: 'Update', stage: 'Completed', progress: 80 });
  assert.equal(created.store.projects[0].progress, 100);
  assert.equal(created.record.progress, 100);
  assert.equal(created.store.followups.length, 1);
  const repeated = post(created.store, technician, { kind: 'Update', stage: 'Completed' });
  assert.equal(repeated.store.followups.length, 1);
});

test('inline custom project stages work in both the timeline and operational project update', () => {
  const store = fixture();
  store.customStatuses = [{ id: 'access-stage', moduleId: 'projects', name: 'Awaiting Customer Access', status: 'Active', terminal: false }];
  const created = post(store, technician, { kind: 'Update', stage: 'Awaiting Customer Access', body: 'Waiting for access' });
  assert.equal(created.record.stage, 'Awaiting Customer Access');
  assert.equal(created.store.projects[0].status, 'Awaiting Customer Access');
});

test('clients may comment and attach media only within their own project', () => {
  const store = fixture();
  assert.deepEqual(projectCapabilities(store, client, 'project-a'), { post: true, updateProgress: false, managePosts: false });
  const created = post(store, client, { body: '', media: [file] });
  assert.equal(created.record.kind, 'Comment');
  assert.throws(() => post(store, client, { kind: 'Update', progress: 50 }), /comment but cannot update/);
  assert.throws(() => post(store, client, { project: 'project-b' }), /FORBIDDEN/);
  assert.throws(() => updateProjectProgress(store, client, 'project-a', { progress: 50 }), /FORBIDDEN/);
});

test('viewers and inactive or unmapped installers cannot write timeline entries', () => {
  const store = fixture();
  assert.equal(projectCapabilities(store, viewer, 'project-a').post, false);
  assert.throws(() => post(store, viewer), /FORBIDDEN/);
  assert.throws(() => post(store, { ...technician, employee: undefined }), /FORBIDDEN/);
  store.employees[0].status = 'Inactive';
  assert.throws(() => post(store), /FORBIDDEN/);
});

test('a reply must reference a live parent within the same project', () => {
  const first = post(fixture());
  const reply = post(first.store, client, { parent: first.record.id, body: 'Thank you' });
  assert.equal(reply.record.parent, first.record.id);
  assert.throws(() => post(first.store, admin, { project: 'project-b', parent: first.record.id }), /same project/);
  const deleted = mutateProjectPost(first.store, admin, 'delete', {}, first.record.id);
  assert.throws(() => post(deleted.store, technician, { parent: first.record.id }), /undeleted/);
});

test('own-author edits and administrator moderation preserve historical progress', () => {
  let result = post(fixture(), technician, { kind: 'Update', progress: 40, stage: 'Testing' });
  const id = result.record.id, postedAt = result.record.postedAt;
  result = mutateProjectPost(result.store, technician, 'update', { body: 'Corrected installation details', media: [file] }, id);
  assert.equal(result.record.postedAt, postedAt);
  assert.equal(result.store.projects[0].progress, 40);
  assert.throws(() => mutateProjectPost(result.store, sales, 'update', { body: 'Rewritten by another employee' }, id), /author or an administrator/);
  result = mutateProjectPost(result.store, admin, 'update', { body: 'Moderated details', pinned: true }, id);
  assert.equal(result.record.pinned, true);
  assert.equal(result.record.authorId, technician.userId);
  assert.throws(() => mutateProjectPost(result.store, technician, 'update', { pinned: false }, id), /Only administrators/);
  for (const data of [{ progress: 90 }, { stage: 'Completed' }, { project: 'project-b' }, { parent: 'new-parent' }, { kind: 'Comment' }]) assert.throws(() => mutateProjectPost(result.store, admin, 'update', data, id), /historical progress/);
});

test('authorship spoofing is rejected on creation and edits', () => {
  for (const key of ['authorId', 'authorName', 'authorRole', 'postedAt', 'authorEmployee']) assert.throws(() => post(fixture(), technician, { [key]: 'Spoof' }), /authorship is assigned/);
  const first = post(fixture());
  assert.throws(() => mutateProjectPost(first.store, admin, 'update', { authorId: 'another-person' }, first.record.id), /authorship is assigned/);
});

test('moderation deletion and restoration never roll back the latest project state', () => {
  const first = post(fixture(), technician, { kind: 'Update', progress: 30 });
  const last = post(first.store, technician, { kind: 'Update', progress: 75 });
  const deleted = mutateProjectPost(last.store, admin, 'delete', {}, last.record.id);
  assert.equal(deleted.store.projects[0].progress, 75);
  const restored = mutateProjectPost(deleted.store, admin, 'restore', {}, last.record.id);
  assert.equal(restored.store.projects[0].progress, 75);
  assert.equal(restored.record.progress, 75);
  assert.throws(() => mutateProjectPost(restored.store, client, 'delete', {}, first.record.id), /author or an administrator/);
});

test('deleted parent posts retain history while hiding replies and their media from ordinary users', () => {
  const first = post(fixture());
  const reply = post(first.store, client, { parent: first.record.id, body: 'Please explain', media: [file] });
  const deleted = mutateProjectPost(reply.store, admin, 'delete', {}, first.record.id);
  assert.equal(visibleStore(deleted.store, client).projectPosts.length, 0);
  assert.equal(canDownloadFile(deleted.store, client, file.key, uploadMetadata(client)), false);
  assert.throws(() => mutateProjectPost(deleted.store, client, 'update', { body: 'Updated question' }, reply.record.id), /FORBIDDEN/);
  const edited = mutateProjectPost(deleted.store, admin, 'update', { body: 'Moderated reply' }, reply.record.id);
  assert.equal(edited.record.parent, first.record.id);
  assert.equal(edited.record.body, 'Moderated reply');
});

test('text or media is required, with bounded body and attachment count', () => {
  const store = fixture();
  assert.throws(() => post(store, technician, { body: '', media: [] }), /comment, details/);
  assert.throws(() => post(store, technician, { body: 'x'.repeat(10001) }), /10,000/);
  assert.throws(() => post(store, technician, { body: 42 }), /10,000/);
  assert.throws(() => post(store, technician, { media: Array.from({ length: 11 }, () => file) }), /up to 10/);
  assert.throws(() => post(store, technician, { media: [{ key: 'https://external.example/video' }] }), /uploaded media/);
  assert.throws(() => post(store, technician, { progress: 30 }), /Only an update/);
  assert.deepEqual(validateRecord('projectPosts', { project: 'project-a', kind: 'Update', body: '', media: [file] }, store), []);
});

test('project archival or deletion makes posting and progress read-only', () => {
  const store = fixture();
  store.projects[0].archivedAt = new Date().toISOString();
  assert.equal(projectCapabilities(store, admin, 'project-a').post, false);
  assert.throws(() => post(store, admin), /FORBIDDEN/);
  delete store.projects[0].archivedAt;
  store.projects[0].deletedAt = new Date().toISOString();
  assert.throws(() => post(store, admin), /FORBIDDEN/);
});

test('published media is available only to viewers of its project', () => {
  const created = post(fixture(), technician, { media: [file] }), metadata = uploadMetadata();
  assert.equal(canDownloadFile(created.store, client, file.key, metadata), true);
  assert.equal(canDownloadFile(created.store, { ...client, customer: 'customer-b' }, file.key, metadata), false);
  assert.equal(canDownloadFile(created.store, { ...technician, employee: 'tech-b' }, file.key, metadata), false);
  assert.equal(canDownloadFile(created.store, viewer, file.key, metadata), true);
});

test('draft uploads are restricted to their creator and expire after 24 hours', () => {
  const store = fixture(), metadata = uploadMetadata();
  assert.equal(canDownloadFile(store, technician, file.key, metadata), true);
  assert.equal(canDownloadFile(store, client, file.key, metadata), false);
  assert.equal(canDownloadFile(store, technician, file.key, { ...metadata, uploadedAt: new Date(Date.now() - 86400001).toISOString() }), false);
  assert.equal(canDownloadFile(store, technician, file.key, { ...metadata, uploadedAt: 'invalid' }), false);
});

test('deleted posts never retain public or creator access through upload metadata', () => {
  const created = post(fixture(), technician, { media: [file] });
  const deleted = mutateProjectPost(created.store, admin, 'delete', {}, created.record.id), metadata = uploadMetadata();
  assert.equal(canDownloadFile(deleted.store, technician, file.key, metadata), false);
  assert.equal(canDownloadFile(deleted.store, client, file.key, metadata), false);
  assert.equal(visibleStore(deleted.store, client).projectPosts.length, 0);
  assert.equal(canDownloadFile(deleted.store, admin, file.key, metadata), true);
});

test('known keys in hidden file fields remain restricted even to their upload creator', () => {
  const store = fixture();
  store.roles.find(role => role.name === 'Technician')!.hiddenFields = 'projectPosts.media,projects.attachments';
  const created = post(fixture(), technician, { media: [file] });
  created.store.roles.find(role => role.name === 'Technician')!.hiddenFields = 'projectPosts.media';
  assert.equal(canDownloadFile(created.store, technician, file.key, uploadMetadata()), false);
  assert.throws(() => post(store, technician, { media: [file] }), /restricted field/);
  store.projects[0].attachments = [file];
  assert.equal(canDownloadFile(store, technician, file.key, { module: 'projects', recordId: 'project-a', creatorId: technician.userId }), false);
});

test('members with hidden media can post text and edit messages without changing restricted attachments', () => {
  const first = post(fixture(), technician, { media: [file] });
  first.store.roles.find(role => role.name === 'Technician')!.hiddenFields = 'projectPosts.media';
  assert.equal(projectCapabilities(first.store, technician, 'project-a').post, true);
  const comment = mutateProjectPost(first.store, technician, 'create', { project: 'project-a', kind: 'Comment', body: 'Text-only site update' });
  assert.equal(comment.record.body, 'Text-only site update');
  const edited = mutateProjectPost(comment.store, technician, 'update', { body: 'Corrected installation details' }, first.record.id);
  assert.deepEqual(edited.record.media, [file]);
  assert.equal(visibleStore(edited.store, technician).projectPosts.some(row => Object.prototype.hasOwnProperty.call(row, 'media')), false);
  assert.throws(() => mutateProjectPost(edited.store, technician, 'create', { project: 'project-a', kind: 'Comment', body: 'Restricted media', media: [] }), /restricted field/);
  assert.throws(() => mutateProjectPost(edited.store, technician, 'update', { media: [] }, first.record.id), /restricted field/);
});

test('authenticated members may preview only the currently linked company logo', () => {
  const store = fixture(), key = store.settings[0].logo[0].key;
  assert.equal(permit(client.role, 'settings', 'download', store), false);
  assert.equal(canDownloadFile(store, client, key, { module: 'settings', recordId: 'company', creatorId: admin.userId }), true);
  assert.equal(canDownloadFile(store, viewer, key, { module: 'settings', creatorId: admin.userId }), true);
  assert.equal(canDownloadFile(store, { ...client, customer: undefined }, key, { module: 'settings', creatorId: admin.userId }), true);
  assert.equal(canDownloadFile(store, { ...technician, employee: undefined }, key, { module: 'settings', creatorId: admin.userId }), true);
  assert.equal(canDownloadFile(store, client, 'files/old-logo/old.png', { module: 'settings', creatorId: admin.userId }), false);
  store.settings[0].attachments = [{ key: 'files/private-company/secret.pdf' }];
  assert.equal(canDownloadFile(store, client, 'files/private-company/secret.pdf', { module: 'settings', creatorId: admin.userId }), false);
});

test('media linking rejects forged cross-project keys and uses authoritative storage metadata', async () => {
  const store = fixture();
  const uploaded = { size: 1200, httpMetadata: { contentType: 'image/png' }, customMetadata: uploadMetadata() };
  const lookup = async () => uploaded;
  const normalized = await validateProjectMediaReferences(store, technician, 'project-a', [{ ...file, type: 'text/html', size: 999, url: 'https://attacker.example' }], lookup);
  assert.equal(normalized[0].type, 'image/png');
  assert.equal(normalized[0].size, 1200);
  assert.ok(normalized[0].url.startsWith('/api/files?key='));
  await assert.rejects(() => validateProjectMediaReferences(store, admin, 'project-b', [file], lookup), /uploaded for this project/);
  await assert.rejects(() => validateProjectMediaReferences(store, technician, 'project-a', [file], async () => ({ ...uploaded, customMetadata: uploadMetadata(technician, 'project-b') })), /FORBIDDEN/);
  await assert.rejects(() => validateProjectMediaReferences(store, technician, 'project-a', [file, file], lookup), /unique media/);
  await assert.rejects(() => validateProjectMediaReferences(store, technician, 'project-a', [file], async () => null), /FORBIDDEN/);
});
