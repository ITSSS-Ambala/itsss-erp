import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { hashPassword } from '../lib/hostinger/password.ts';

await mkdir(resolve('outputs'), { recursive: true });
const state = await mkdtemp(resolve('outputs/hostinger-smoke-'));
const temporaryListener = createServer();
await new Promise(done => temporaryListener.listen(0, '127.0.0.1', done));
const port = temporaryListener.address().port;
await new Promise(done => temporaryListener.close(done));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString('hex');
const passwordHash = await hashPassword(password);
const staffEmail = 'staff-test@itsss.test';
const env = { ...process.env, NODE_ENV: 'production', HOSTNAME: '0.0.0.0', PORT: String(port), ERP_PUBLIC_URL: origin, ERP_DATA_DIR: state, ERP_ADMIN_EMAIL: 'deployment-test@itsss.test', ERP_ADMIN_NAME: 'Deployment Test', ERP_ADMIN_PASSWORD_HASH: passwordHash, ERP_VAULT_KEY: randomBytes(32).toString('base64'), ERP_AUTH_USERS: JSON.stringify([{ email: staffEmail, name: 'Test Viewer', passwordHash }]), ERP_SESSION_HOURS: '12' };
const isolated = process.argv.includes('--standalone');
let isolatedServerDirectory;
let server;
let serverOutput = '';
const checks = [];
function record(name) { checks.push(name); console.log(`PASS ${name}`); }
async function start() {
  serverOutput = '';
  server = spawn(process.execPath, [isolated ? resolve(isolatedServerDirectory, 'server.js') : 'scripts/start-hostinger.mjs'], { env, cwd: isolatedServerDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { serverOutput = (serverOutput + data).slice(-6000); });
  server.stderr.on('data', data => { serverOutput = (serverOutput + data).slice(-6000); });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited: ${serverOutput}`);
    try { if ((await fetch(origin + '/login', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`Production server was not ready: ${serverOutput}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(done => server.once('exit', done));
  server.kill('SIGTERM'); await exited;
}
async function request(path, options = {}, expected = 200) {
  const response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, expected, `${path} returned ${response.status}`);
  return response;
}
try {
  if (isolated) {
    isolatedServerDirectory = await mkdtemp(resolve(tmpdir(), 'itsss-standalone-'));
    await cp(resolve('.next/standalone'), isolatedServerDirectory, { recursive: true, dereference: true });
  }
  await start();
  const html = await (await request('/')).text();
  await request('/favicon.svg');
  const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"\s]*\/_next\/static\/[^"\s]+)"/g)].map(match => match[1].replaceAll('&amp;', '&')))];
  assert.ok(assets.some(asset => asset.endsWith('.js')), 'Production page must include JavaScript assets');
  assert.ok(assets.some(asset => asset.endsWith('.css')), 'Production page must include CSS assets');
  for (const asset of assets) {
    const response = await request(asset);
    assert.ok(!response.headers.get('content-type')?.includes('text/html'), 'Static assets must not return an HTML fallback');
  }
  record('production pages, public assets and built JavaScript/CSS assets');
  for (const path of ['/api/workspace', '/api/notifications', '/api/files?key=files/test/test.txt', '/api/backup']) await request(path, {}, 401);
  await request('/api/workspace', { headers: { 'oai-authenticated-user-id': 'forged-owner', 'oai-authenticated-user-email': env.ERP_ADMIN_EMAIL } }, 401);
  record('anonymous and forged identity-header access rejected');
  const staffSignIn = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: staffEmail, password }) });
  const staffCookie = staffSignIn.headers.get('set-cookie').split(';')[0];
  await request('/api/workspace', { headers: { Cookie: staffCookie } }, 403);
  record('additional accounts cannot claim an uninitialized workspace');
  const loginBody = JSON.stringify({ email: env.ERP_ADMIN_EMAIL, password, returnTo: '//evil.test' });
  await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: loginBody }, 403);
  await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: loginBody }, 403);
  await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: env.ERP_ADMIN_EMAIL, password: 'wrong password' }) }, 401);
  const signedIn = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: loginBody });
  assert.equal((await signedIn.json()).returnTo, '/');
  const setCookie = signedIn.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(';')[0];
  record('password login, CSRF checks and safe return URL');
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  let workspace = await (await request('/api/workspace', { headers })).json();
  assert.equal(workspace.user.role, 'Super Admin');
  await request('/api/workspace', { headers: { Cookie: staffCookie } }, 401);
  const viewerRole = workspace.store.roles.find(role => role.name === 'Viewer');
  assert.ok(viewerRole);
  workspace = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'users', action: 'create', data: { name: 'Test Viewer', email: staffEmail, role: viewerRole.id, status: 'Active' } }) })).json();
  const viewerWorkspace = await (await request('/api/workspace', { headers: { Cookie: staffCookie } })).json();
  assert.equal(viewerWorkspace.user.role, 'Viewer');
  await request('/api/workspace', { method: 'POST', headers: { ...headers, Cookie: staffCookie }, body: JSON.stringify({ revision: viewerWorkspace.revision, module: 'customers', action: 'create', data: { name: 'Forbidden viewer write' } }) }, 403);
  record('team credentials require ERP membership and enforce assigned roles');
  const managedEmail = 'managed-user@itsss.test';
  const managedPassword = randomBytes(24).toString('hex');
  const replacementPassword = randomBytes(24).toString('hex');
  workspace = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'users', action: 'create', data: { name: 'Managed User', email: managedEmail, role: viewerRole.id, status: 'Active' } }) })).json();
  const memberId = workspace.createdRecordId;
  const resetBody = () => JSON.stringify({ revision: workspace.revision, memberId, mode: 'reset', password: managedPassword });
  await request('/api/auth/password', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: resetBody() }, 401);
  await request('/api/auth/password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: resetBody() }, 403);
  await request('/api/auth/password', { method: 'POST', headers: { ...headers, Cookie: staffCookie }, body: resetBody() }, 403);
  await request('/api/auth/password', { method: 'POST', headers, body: JSON.stringify({ padding: 'x'.repeat(5000) }) }, 400);
  await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'users', action: 'update', id: memberId, data: { password: managedPassword } }) }, 400);
  await request('/api/auth/password', { method: 'POST', headers, body: resetBody() });
  const managedLogin = await request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: managedEmail, password: managedPassword }) });
  const originalManagedCookie = managedLogin.headers.get('set-cookie').split(';')[0];
  workspace = await (await request('/api/workspace', { headers })).json();
  const changeBody = currentPassword => JSON.stringify({ revision: workspace.revision, memberId, mode: 'change', password: replacementPassword, currentPassword });
  await request('/api/auth/password', { method: 'POST', headers: { ...headers, Cookie: originalManagedCookie }, body: changeBody('incorrect password') }, 400);
  const changed = await request('/api/auth/password', { method: 'POST', headers: { ...headers, Cookie: originalManagedCookie }, body: changeBody(managedPassword) });
  assert.equal((await changed.json()).signInAgain, true);
  await request('/api/workspace', { headers: { Cookie: originalManagedCookie } }, 401);
  await request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: managedEmail, password: managedPassword }) }, 401);
  const replacementLogin = await request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: managedEmail, password: replacementPassword }) });
  const managedCookie = replacementLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await request('/api/workspace', { headers: { Cookie: managedCookie } })).json()).user.role, 'Viewer');
  workspace = await (await request('/api/workspace', { headers })).json();
  const serializedWorkspace = JSON.stringify(workspace);
  assert.ok(!serializedWorkspace.includes(managedPassword) && !serializedWorkspace.includes(replacementPassword) && !serializedWorkspace.includes('scrypt$'));
  record('managed user password setup, self-service change, permissions, bounds and session revocation');
  const mutation = { revision: workspace.revision, module: 'customers', action: 'create', data: { name: 'Production deployment verification', status: 'Active' } };
  const created = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify(mutation) })).json();
  assert.ok(created.createdRecordId);
  await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify(mutation) }, 409);
  record('workspace initialization, record save and stale revision rejection');
  workspace = created;
  const technicianRole = workspace.store.roles.find(role => role.name === 'Technician');
  workspace = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'employees', action: 'create', data: { name: 'Notification Test Technician', role: 'Technician', status: 'Active' } }) })).json();
  const notificationEmployee = workspace.createdRecordId;
  workspace = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'users', action: 'update', id: memberId, data: { role: technicianRole.id, employee: notificationEmployee } }) })).json();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  workspace = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'tasks', action: 'import', data: Array.from({ length: 21 }, (_, i) => ({ name: `Notification verification task ${i + 1}`, assignedTo: notificationEmployee, dueDate: today, status: 'To Do' })) }) })).json();
  const technicianHeaders = { ...headers, Cookie: managedCookie };
  const personalInbox = await (await request('/api/notifications', { headers: technicianHeaders })).json();
  assert.equal(personalInbox.notifications.filter(row => row.type === 'Task Assignment').length, 21);
  assert.equal(personalInbox.notifications.filter(row => row.type === 'Task Due').length, 21);
  assert.equal(personalInbox.unreadCount, 42);
  assert.ok(personalInbox.notifications.every(row => row.recipientUserId === memberId && row.channel === 'In-App' && row.deliveryVersion === 1));
  const ownerInbox = await (await request('/api/notifications', { headers })).json();
  assert.equal(ownerInbox.notifications.filter(row => row.type === 'Task Assignment').length, 0, 'the actor does not receive their own assignment event');
  assert.equal((await (await request('/api/notifications', { headers: { Cookie: staffCookie } })).json()).notifications.length, 0);
  const readBody = JSON.stringify({ ids: [personalInbox.notifications[0].id] });
  await request('/api/notifications', { method: 'POST', headers: { Cookie: managedCookie, 'Content-Type': 'application/json' }, body: readBody }, 403);
  await request('/api/notifications', { method: 'POST', headers: technicianHeaders, body: JSON.stringify({ ids: [personalInbox.notifications[0].id, ownerInbox.notifications[0].id] }) }, 403);
  const readOne = await (await request('/api/notifications', { method: 'POST', headers: technicianHeaders, body: readBody })).json();
  assert.equal(readOne.unreadCount, 41);
  const readAll = await (await request('/api/notifications', { method: 'POST', headers: technicianHeaders, body: JSON.stringify({ all: true }) })).json();
  assert.equal(readAll.unreadCount, 0);
  assert.equal((await (await request('/api/notifications', { headers })).json()).unreadCount, ownerInbox.unreadCount);
  assert.equal((await (await request('/api/workspace', { headers })).json()).revision, workspace.revision, 'reading notifications does not conflict with business edits');
  await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'notifications', action: 'create', data: { name: 'Fabricated notification' } }) }, 403);
  const completedTask = personalInbox.notifications[0].sourceId;
  workspace = await (await request('/api/workspace', { method: 'POST', headers, body: JSON.stringify({ revision: workspace.revision, module: 'tasks', action: 'update', id: completedTask, data: { status: 'Completed' } }) })).json();
  const updatedInbox = await (await request('/api/notifications', { headers: technicianHeaders })).json();
  assert.equal(updatedInbox.notifications.filter(row => row.type === 'Task Due').length, 20);
  assert.ok(!updatedInbox.notifications.some(row => row.type === 'Task Due' && row.sourceId === completedTask));
  assert.equal(updatedInbox.unreadCount, 1, 'a subsequent genuine status change creates a new unread event');
  const savedReadIds = updatedInbox.notifications.filter(row => row.read).map(row => row.id).sort();
  record('personal notification delivery, all 42 items, saved reads, CSRF, recipient isolation and resolved reminders');
  const bytes = Buffer.from('Private upload: production verification.');
  const form = new FormData(); form.set('module', 'documents'); form.set('file', new Blob([bytes], { type: 'text/plain' }), 'verification.txt');
  const uploaded = await (await request('/api/files', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: form })).json();
  assert.ok(uploaded.key);
  assert.deepEqual(Buffer.from(await (await request(uploaded.url, { headers: { Cookie: cookie } })).arrayBuffer()), bytes);
  const partial = await request(uploaded.url, { headers: { Cookie: cookie, Range: 'bytes=2-6' } }, 206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(2, 7));
  await request(uploaded.url, {}, 401);
  record('private upload, byte-identical download and range response');
  const backup = await (await request('/api/backup', { headers: { Cookie: cookie } })).json();
  assert.equal(backup.format, 'itsss-erp-v1');
  const serializedBackup = JSON.stringify(backup);
  assert.ok(!serializedBackup.includes(managedPassword) && !serializedBackup.includes(replacementPassword) && !serializedBackup.includes('scrypt$'));
  assert.ok(backup.store.vault.every(record => record.encrypted && !record.password));
  record('authenticated encrypted backup');
  await stop(); await start();
  const reloaded = await (await request('/api/workspace', { headers: { Cookie: cookie } })).json();
  assert.ok(reloaded.store.customers.some(row => row.id === created.createdRecordId));
  assert.deepEqual(Buffer.from(await (await request(uploaded.url, { headers: { Cookie: cookie } })).arrayBuffer()), bytes);
  await request('/api/workspace', { headers: { Cookie: managedCookie } });
  await request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: managedEmail, password: replacementPassword }) });
  const restartedInbox = await (await request('/api/notifications', { headers: technicianHeaders })).json();
  assert.deepEqual(restartedInbox.notifications.filter(row => row.read).map(row => row.id).sort(), savedReadIds);
  assert.equal(restartedInbox.unreadCount, 1);
  record('personal notification events and independent read state survive server restart');
  record('records, managed passwords, sessions and uploaded files survive server restart');
  await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, redirect: 'manual' }, 303);
  await request('/api/workspace', { headers: { Cookie: cookie } }, 401);
  record('logout revokes server-side session');
  await writeFile(resolve(`outputs/hostinger-${isolated ? 'standalone' : 'smoke'}-verification.json`), JSON.stringify({ deploymentUrl: 'https://crm.itsss.co.in', runtime: 'Next.js / Node.js 24', entryFile: '.next/standalone/server.js', isolatedFromSourceDependencies: isolated, checks, passed: true, scope: 'local production server; live Hostinger deployment not performed' }, null, 2));
} finally {
  await stop();
  const cleanupPath = relative(resolve('outputs'), state);
  assert.ok(cleanupPath && !cleanupPath.startsWith('..'), 'Smoke cleanup must stay inside outputs');
  await rm(state, { recursive: true, force: true });
  if (isolatedServerDirectory) {
    const serverCleanupPath = relative(resolve(tmpdir()), isolatedServerDirectory);
    assert.ok(serverCleanupPath && !serverCleanupPath.startsWith('..') && serverCleanupPath.startsWith('itsss-standalone-'), 'Standalone cleanup must stay inside its temporary directory');
    await rm(isolatedServerDirectory, { recursive: true, force: true });
  }
}
