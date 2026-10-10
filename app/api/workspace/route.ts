import { env } from '../../../lib/runtime';
import { loadWorkspace, loadNotificationWorkspace, saveWorkspace, apiError, checkOrigin, workspaceResponse, requestActor } from '../../../lib/server';
import { applyMutation, runAutomations, type Action } from '../../../lib/engine';
import { assertMutationAccess, resolveRole, canDownloadFile } from '../../../lib/access';
import { resolveModules, type ERPRecord, type Store } from '../../../lib/schema';
import { createDropdownOption } from '../../../lib/dropdowns';
import { mutateProjectPost, updateProjectProgress, validateProjectMediaReferences } from '../../../lib/project-posts';
import { validateLogoMetadata, validateMediaUpload } from '../../../lib/media';
import { synchronizeNotifications } from '../../../lib/notifications';
import { parseBulkAction } from '../../../lib/bulk-actions';

export async function GET() {
  try {
    const loaded=await loadNotificationWorkspace();
    return workspaceResponse(loaded.store,loaded.revision,loaded.user);
  } catch(error) { return apiError(error); }
}
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const {store,revision,user}=await loadWorkspace();
    const body=await request.json() as {revision?:number;module?:string;action?:string;id?:string;field?:string;data?:unknown};
    if(body.revision!==revision)throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
    const moduleId=String(body.module||''),action=String(body.action||'');
    if(!['create','update','delete','restore','duplicate','archive','permanentDelete','import','bulk','createOption','updateProjectProgress'].includes(action))throw new Error('Unsupported action.');
    const module=resolveModules(store).find(item=>item.id===moduleId);
    if(!module)throw new Error('Unknown module.');
    const actor=requestActor(request,user);
    if(action==='updateProjectProgress') {
      if(moduleId!=='projects'||!body.id)throw new Error('Choose a project to update.');
      if(!body.data||typeof body.data!=='object'||Array.isArray(body.data))throw new Error('Provide project progress or a stage.');
      const result=updateProjectProgress(store,user,body.id,body.data as Partial<ERPRecord>,actor);
      const next=synchronizeNotifications(runAutomations(result.store).store,new Date(),store,user.memberId).store;
      const nextRevision=await saveWorkspace(next,revision);
      return workspaceResponse(next,nextRevision,user);
    }
    if(action==='createOption') {
      const data=body.data&&typeof body.data==='object'&&!Array.isArray(body.data)?body.data as {name?:unknown}:{};
      const created=createDropdownOption(store,user,{moduleId,fieldKey:String(body.field||''),name:data.name,expectedRevision:body.revision,revision},actor);
      const nextRevision=created.reused?revision:await saveWorkspace(created.store,revision);
      return workspaceResponse(created.store,nextRevision,user,{option:{value:created.value,reused:created.reused,module:moduleId,field:String(body.field||'')}});
    }
    let next:Store=store;
    let createdRecordId:string|undefined;
    const prepare=(raw:unknown)=>{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Record data must be an object.');
      const data={...raw} as Partial<ERPRecord>;
      if(moduleId==='users'&&['password','passwordHash','newPassword','currentPassword'].some(key=>key in data))throw new Error('Use Set password to manage login credentials.');
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
      if(moduleId==='projectPosts'&&data.media!==undefined) data.media=await validateProjectMediaReferences(next,user,String(data.project||existing?.project),data.media,async key=>(await env.BUCKET?.head(key))||null);
      for(const field of module.fields.filter(item=>['file','image'].includes(item.type.toLowerCase()))) {
        if(moduleId==='projectPosts'&&field.key==='media')continue;
        const files=data[field.key];
        if(files===undefined)continue;
        if(!Array.isArray(files))throw new Error('Uploaded files must be a list.');
        for(const file of files) {
          if(!file||typeof file!=='object'||typeof file.key!=='string'||!/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(file.key))throw new Error('Choose a file uploaded to this workspace.');
          const uploaded=await env.BUCKET?.head(file.key);
          if(!uploaded||!canDownloadFile(store,user,file.key,{...uploaded.customMetadata,contentType:uploaded.httpMetadata?.contentType||'',size:String(uploaded.size)}))throw new Error('FORBIDDEN: You cannot link a restricted file.');
          if(moduleId==='settings'&&field.key==='logo') {
            if(files.length>1)throw new Error('Choose one company logo.');
            validateLogoMetadata(uploaded);
            const object=await env.BUCKET?.get(file.key);
            if(!object)throw new Error('Logo file not found.');
            await validateMediaUpload(new File([await object.arrayBuffer()],uploaded.customMetadata?.name||'logo',{type:uploaded.httpMetadata?.contentType||''}),'logo');
          }
          const index=files.indexOf(file);
          files[index]={key:file.key,url:'/api/files?key='+encodeURIComponent(file.key),name:uploaded.customMetadata?.name||'File',type:uploaded.httpMetadata?.contentType||'application/octet-stream',size:uploaded.size};
        }
      }
      if(moduleId==='users'&&existing?.id===user.memberId) {
        const target={...existing,...data};
        if(!['Super Admin','Admin'].includes(resolveRole(target.role,next))||target.status!=='Active'||target.email?.toLowerCase()!==user.email?.toLowerCase()||['delete','archive','permanentDelete'].includes(operation))throw new Error('Keep your current administrator membership active.');
      }
      const result=moduleId==='projectPosts'?mutateProjectPost(next,user,operation,data,id,actor):applyMutation(next,moduleId,operation,data,id,actor);
      if(operation==='create'||operation==='duplicate'){result.record.createdById=user.userId;createdRecordId=result.record.id;}
      next=result.store;
    };
    if(action==='bulk') {
      const bulk=parseBulkAction(body.data,module);
      for(const id of bulk.ids) await change(prepare(bulk.data),bulk.operation,id);
    } else if(action==='import') {
      if(!Array.isArray(body.data)||!body.data.length||body.data.length>500)throw new Error('Import between 1 and 500 rows at once.');
      for(const raw of body.data)await change(prepare(raw),'create');
    } else {
      const id=moduleId==='settings'?store.settings?.[0]?.id:body.id;
      await change(prepare(body.data||{}),action as Action,id);
    }
    next=synchronizeNotifications(runAutomations(next).store,new Date(),store,user.memberId).store;
    const nextRevision=await saveWorkspace(next,revision);
    return workspaceResponse(next,nextRevision,user,{createdRecordId,createdRecordModule:moduleId});
  } catch(error) { return apiError(error); }
}
