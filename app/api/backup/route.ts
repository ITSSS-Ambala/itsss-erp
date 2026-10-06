import { loadWorkspace, saveWorkspace, apiError, checkOrigin, requestActor } from '../../../lib/server';
import { validatedRestore } from '../../../lib/access';
import { env } from 'cloudflare:workers';
import { sealVault, openVault } from '../../../lib/vault';
export async function GET() {
  try {
    const {store,revision,user}=await loadWorkspace();
    if(!['Admin','Super Admin'].includes(user.role))throw new Error('FORBIDDEN: Administrator access required.');
    const encrypted=await sealVault(store,env.ERP_VAULT_KEY||'');
    return Response.json({format:'itsss-erp-v1',createdAt:new Date().toISOString(),revision,store:encrypted},{headers:{'Content-Disposition':'attachment; filename="ITSSS-backup-'+new Date().toISOString().slice(0,10)+'.json"','Cache-Control':'private, no-store'}});
  } catch(error) { return apiError(error); }
}
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const {store,revision,user}=await loadWorkspace();
    if(!['Admin','Super Admin'].includes(user.role))throw new Error('FORBIDDEN: Administrator access required.');
    const body=await request.json() as {format?:string;store?:unknown};
    if(body.format!=='itsss-erp-v1')throw new Error('Choose a valid ITSSS backup.');
    if(!body.store||typeof body.store!=='object'||Array.isArray(body.store))throw new Error('Choose a valid ITSSS backup.');
    const decrypted=await openVault(body.store as import('../../../lib/schema').Store,env.ERP_VAULT_KEY||'');
    const restored=validatedRestore(decrypted,store),actor=requestActor(request,user),date=new Date().toISOString();
    restored.auditLogs.push({id:crypto.randomUUID(),name:'Workspace restored',actor:actor.name,actorId:actor.id,action:'restoreBackup',module:'backups',date,device:actor.device,ip:actor.ip,oldValue:JSON.stringify({revision}),newValue:JSON.stringify({modules:Object.keys(restored),records:Object.values(restored).reduce((total,rows)=>total+rows.length,0)})});
    restored.activities.push({id:crypto.randomUUID(),name:'Workspace restored from backup',module:'backups',action:'restoreBackup',actor:actor.name,date});
    restored.backups||=[];
    restored.backups.push({id:crypto.randomUUID(),name:'Manual restore',type:'Manual',date,status:'Restored',destination:'Workspace database',notes:'Database records restored. R2 file references retained; workspace membership and current audit history preserved.'});
    await saveWorkspace(restored,revision);
    return Response.json({success:true});
  } catch(error) { return apiError(error); }
}
