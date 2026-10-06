import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../app/chatgpt-auth';
import { createSeed } from './seed';
import { sealVault, openVault } from './vault';
import { resolveModules, type Store } from './schema';
import { resolveRole, permit, visibleStore, hiddenFields, type AccessUser } from './access';
export { permit, visibleStore } from './access';
export type { Store } from './schema';
export async function identity() {
  const user = await getChatGPTUser();
  if (!user) throw new Error('AUTH: Please sign in to your workspace.');
  return user;
}
export async function loadWorkspace() {
  if (!env.DB) throw new Error('Database is unavailable.');
  const identityUser = await identity();
  let row = await env.DB.prepare('SELECT data, revision FROM erp_workspace WHERE id = ?').bind('main').first<{data:string;revision:number}>();
  if (!row) {
    const data = createSeed();
    const ownerRole = data.roles.find(role => role.name === 'Super Admin');
    if (!ownerRole) throw new Error('Administrator role is unavailable.');
    data.users = [{id:identityUser.userId,name:identityUser.displayName,email:identityUser.email,role:ownerRole.id,status:'Active',identityId:identityUser.userId}];
    data.settings = [{...data.settings?.[0],id:'company',name:'ITSSS',fullName:'IT Smart Solution and Services',currency:'INR',theme:'Light',demo:true}];
    const encrypted = await sealVault(data,env.ERP_VAULT_KEY||'');
    await env.DB.prepare('INSERT OR IGNORE INTO erp_workspace (id,data,revision,updated_at) VALUES (?,?,0,?)').bind('main',JSON.stringify(encrypted),new Date().toISOString()).run();
    row = await env.DB.prepare('SELECT data, revision FROM erp_workspace WHERE id = ?').bind('main').first<{data:string;revision:number}>();
  }
  if (!row) throw new Error('Unable to initialize workspace.');
  const store: Store = await openVault(JSON.parse(row.data),env.ERP_VAULT_KEY||'');
  let migrated=false;
  for(const member of store.users||[]) {
    const legacy=(store.roles||[]).find(role=>!role.deletedAt&&role.status!=='Inactive'&&role.name===member.role);
    if(legacy&&legacy.id!==member.role){member.role=legacy.id;migrated=true;}
  }
  for(const setting of store.settings||[])if(['light','dark','system'].includes(setting.theme)){setting.theme=setting.theme[0].toUpperCase()+setting.theme.slice(1);migrated=true;}
  const member = (store.users||[]).find(record=>!record.deletedAt&&!record.archivedAt&&record.status==='Active'&&(record.identityId?record.identityId===identityUser.userId:record.email?.toLowerCase()===identityUser.email.toLowerCase()));
  if (!member) throw new Error('FORBIDDEN: Your account is not an active member of this ERP workspace.');
  const role = resolveRole(member.role,store);
  if (role==='Unassigned') throw new Error('FORBIDDEN: Your account needs an active role assignment.');
  const user: AccessUser = {userId:identityUser.userId,displayName:identityUser.displayName,email:identityUser.email,memberId:member.id,role,employee:member.employee||member.technician,customer:member.customer};
  return {store,revision:migrated?await saveWorkspace(store,row.revision):row.revision,user};
}
export async function saveWorkspace(store:Store,revision:number) {
  const encrypted = await sealVault(store,env.ERP_VAULT_KEY||'');
  const result=await env.DB!.prepare('UPDATE erp_workspace SET data=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(encrypted),new Date().toISOString(),'main',revision).run();
  if(result.meta.changes!==1)throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
  return revision+1;
}
export function permissionsFor(store:Store,user:AccessUser) {
  return Object.fromEntries(resolveModules(store).map(module=>[module.id,Object.fromEntries(['view','add','edit','delete','export','approve','archive','restore','permanentDelete','download'].map(action=>[action,permit(user.role,module.id,action,store)]))]));
}
export function workspaceResponse(store:Store,revision:number,user:AccessUser) {
  return Response.json({store:visibleStore(store,user),revision,user,permissions:permissionsFor(store,user),hiddenFields:Object.fromEntries(resolveModules(store).map(module=>[module.id,[...hiddenFields(store,user,module.id)]]))},{headers:{'Cache-Control':'private, no-store'}});
}
export function requestActor(request:Request,user:AccessUser) {
  return {id:user.userId,name:user.displayName,email:user.email,role:user.role,device:(request.headers.get('user-agent')||'Web browser').slice(0,500),ip:(request.headers.get('cf-connecting-ip')||'Unavailable').slice(0,80)};
}
export function apiError(error:unknown) {
  const message=error instanceof Error?error.message:'Unexpected error';
  return Response.json({error:message.replace(/^(AUTH|FORBIDDEN|CONFLICT): /,'')},{status:message.startsWith('AUTH:')?401:message.startsWith('FORBIDDEN:')?403:message.startsWith('CONFLICT:')?409:400,headers:{'Cache-Control':'private, no-store'}});
}
export function checkOrigin(request:Request) {
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)throw new Error('FORBIDDEN: Invalid request origin.');
  if(request.headers.get('sec-fetch-site')==='cross-site')throw new Error('FORBIDDEN: Cross-site requests are not allowed.');
}
