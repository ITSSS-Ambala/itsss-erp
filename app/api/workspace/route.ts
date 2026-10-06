import { env } from 'cloudflare:workers';
import { loadWorkspace, saveWorkspace, apiError, checkOrigin, workspaceResponse, requestActor } from '../../../lib/server';
import { applyMutation, runAutomations, type Action } from '../../../lib/engine';
import { assertMutationAccess, resolveRole, canDownloadFile } from '../../../lib/access';
import { resolveModules, type ERPRecord, type Store } from '../../../lib/schema';

export async function GET() {
  try {
    const loaded=await loadWorkspace();
    const automated=runAutomations(loaded.store);
    const revision=automated.created?await saveWorkspace(automated.store,loaded.revision):loaded.revision;
    return workspaceResponse(automated.created?automated.store:loaded.store,revision,loaded.user);
  } catch(error) { return apiError(error); }
}
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const {store,revision,user}=await loadWorkspace();
    const body=await request.json() as {revision?:number;module?:string;action?:string;id?:string;data?:unknown};
    if(body.revision!==revision)throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
    const moduleId=String(body.module||''),action=String(body.action||'');
    if(!['create','update','delete','restore','duplicate','archive','permanentDelete','import'].includes(action))throw new Error('Unsupported action.');
    const module=resolveModules(store).find(item=>item.id===moduleId);
    if(!module)throw new Error('Unknown module.');
    const actor=requestActor(request,user);
    let next:Store=store;
    const prepare=(raw:unknown)=>{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Record data must be an object.');
      const data={...raw} as Partial<ERPRecord>;
      for(const key of ['id','createdAt','updatedAt','createdBy','createdById','deletedAt','deletedBy','archivedAt','systemGenerated','identityId'])delete data[key];
      if(user.role==='Technician') {
        for(const key of ['technician','assignedTo','employee'])if(module.fields.some(field=>field.key===key)&&(!data[key]||action==='create')) {
          if(data[key]&&data[key]!==user.employee)throw new Error('FORBIDDEN: You cannot assign work to another employee.');
          data[key]=user.employee;
        }
      }
      for (const field of module.fields.filter(item => ['file','image'].includes(item.type.toLowerCase()))) {
        if (data[field.key] === '' || data[field.key] === null) data[field.key] = [];
      }
      return data;
    };
    const change=async(data:Partial<ERPRecord>,operation:Action,id?:string)=>{
      const existing=id?(next[moduleId]||[]).find(row=>row.id===id):undefined;
      assertMutationAccess(next,user,moduleId,operation,data,existing);
      for(const field of module.fields.filter(item=>['file','image'].includes(item.type.toLowerCase()))) {
        const files=data[field.key];
        if(files===undefined)continue;
        if(!Array.isArray(files))throw new Error('Uploaded files must be a list.');
        for(const file of files) {
          if(!file||typeof file!=='object'||typeof file.key!=='string'||!/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(file.key))throw new Error('Choose a file uploaded to this workspace.');
          const uploaded=await env.BUCKET?.head(file.key);
          if(!uploaded||!canDownloadFile(store,user,file.key,uploaded.customMetadata))throw new Error('FORBIDDEN: You cannot link a restricted file.');
          file.url='/api/files?key='+encodeURIComponent(file.key);
        }
      }
      if(moduleId==='users'&&existing?.id===user.memberId) {
        const target={...existing,...data};
        if(!['Super Admin','Admin'].includes(resolveRole(target.role,next))||target.status!=='Active'||target.email?.toLowerCase()!==user.email?.toLowerCase()||['delete','archive','permanentDelete'].includes(operation))throw new Error('Keep your current administrator membership active.');
      }
      const result=applyMutation(next,moduleId,operation,data,id,actor);
      if(operation==='create'||operation==='duplicate')result.record.createdById=user.userId;
      next=result.store;
    };
    if(action==='import') {
      if(!Array.isArray(body.data)||!body.data.length||body.data.length>500)throw new Error('Import between 1 and 500 rows at once.');
      for(const raw of body.data)await change(prepare(raw),'create');
    } else {
      const id=moduleId==='settings'?store.settings?.[0]?.id:body.id;
      await change(prepare(body.data||{}),action as Action,id);
    }
    next=runAutomations(next).store;
    const nextRevision=await saveWorkspace(next,revision);
    return workspaceResponse(next,nextRevision,user);
  } catch(error) { return apiError(error); }
}
