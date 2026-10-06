import { env } from 'cloudflare:workers';
import { loadWorkspace, apiError, checkOrigin } from '../../../lib/server';
import { canViewRecord, canDownloadFile, permit } from '../../../lib/access';
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const {store,user}=await loadWorkspace(),form=await request.formData();
    const file=form.get('file'),moduleId=String(form.get('module')||'documents'),recordId=String(form.get('recordId')||'');
    if(user.role==='Technician'&&(!user.employee||!(store.employees||[]).some(row=>row.id===user.employee&&!row.deletedAt&&!row.archivedAt&&row.status!=='Inactive')))throw new Error('FORBIDDEN: Your account needs an active technician assignment.');
    if(!permit(user.role,moduleId,recordId?'edit':'add',store))throw new Error('FORBIDDEN: You cannot upload files here.');
    if(recordId) {
      const row=(store[moduleId]||[]).find(record=>record.id===recordId&&!record.deletedAt);
      if(!row||!canViewRecord(store,user,moduleId,row))throw new Error('FORBIDDEN: This record is outside your assigned scope.');
    }
    if(!(file instanceof File)||file.size>20*1024*1024||!file.size)throw new Error('Choose a file between 1 byte and 20 MB.');
    if(!env.BUCKET)throw new Error('File storage is unavailable.');
    const key='files/'+crypto.randomUUID()+'/'+file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
    await env.BUCKET.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type||'application/octet-stream'},customMetadata:{name:file.name,module:moduleId,recordId,creatorId:user.userId}});
    return Response.json({name:file.name,key,url:'/api/files?key='+encodeURIComponent(key),size:file.size,type:file.type});
  } catch(error) { return apiError(error); }
}
export async function GET(request:Request) {
  try {
    const {store,user}=await loadWorkspace(),key=new URL(request.url).searchParams.get('key');
    if(!key||!/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(key))throw new Error('Invalid file.');
    const file=await env.BUCKET?.get(key);
    if(!file)return new Response('File not found',{status:404});
    if(!canDownloadFile(store,user,key,file.customMetadata))throw new Error('FORBIDDEN: This file is restricted.');
    return new Response(file.body,{headers:{'Content-Type':file.httpMetadata?.contentType||'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.customMetadata?.name||'document'),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});
  } catch(error) { return apiError(error); }
}
