import { env } from '../../../lib/runtime';
import { loadWorkspace, apiError, checkOrigin } from '../../../lib/server';
import { canViewRecord, canDownloadFile, permit, projectCapabilities, assertMutationAccess, hiddenFields } from '../../../lib/access';
import { validateMediaUpload, validateLogoMetadata, parseByteRange, MediaRangeError, fileResponseHeaders } from '../../../lib/media';
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const {store,user}=await loadWorkspace(),form=await request.formData();
    const file=form.get('file'),moduleId=String(form.get('module')||'documents'),recordId=String(form.get('recordId')||''),projectId=String(form.get('projectId')||'');
    if(user.role==='Technician'&&(!user.employee||!(store.employees||[]).some(row=>row.id===user.employee&&!row.deletedAt&&!row.archivedAt&&row.status!=='Inactive')))throw new Error('FORBIDDEN: Your account needs an active technician assignment.');
    if(moduleId==='projectPosts') {
      if(!projectCapabilities(store,user,projectId).post||hiddenFields(store,user,'projectPosts').has('media'))throw new Error('FORBIDDEN: You cannot upload media for this project.');
      if(recordId) {
        const post=(store.projectPosts||[]).find(row=>row.id===recordId&&!row.deletedAt);
        if(!post||post.project!==projectId)throw new Error('FORBIDDEN: This post is outside your project.');
        assertMutationAccess(store,user,'projectPosts','update',{},post);
      }
    } else if(!permit(user.role,moduleId,recordId?'edit':'add',store))throw new Error('FORBIDDEN: You cannot upload files here.');
    if(recordId) {
      const row=(store[moduleId]||[]).find(record=>record.id===recordId&&!record.deletedAt);
      if(!row||!canViewRecord(store,user,moduleId,row))throw new Error('FORBIDDEN: This record is outside your assigned scope.');
    }
    if(!(file instanceof File))throw new Error('Choose a file to upload.');
    const validated=await validateMediaUpload(file,moduleId==='projectPosts'?'timeline':moduleId==='settings'?'logo':'document');
    if(!env.BUCKET)throw new Error('File storage is unavailable.');
    const key='files/'+crypto.randomUUID()+'/'+file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
    await env.BUCKET.put(key,file.stream(),{httpMetadata:{contentType:validated.contentType},customMetadata:{name:file.name,module:moduleId,recordId,projectId,creatorId:user.userId,uploadedAt:new Date().toISOString()}});
    return Response.json({name:file.name,key,url:'/api/files?key='+encodeURIComponent(key),size:file.size,type:validated.contentType},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) { return apiError(error); }
}
export async function GET(request:Request) {
  try {
    const {store,user}=await loadWorkspace(),params=new URL(request.url).searchParams,key=params.get('key');
    if(!key||!/^files\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(key))throw new Error('Invalid file.');
    const object=await env.BUCKET?.head(key);
    if(!object)return new Response('File not found',{status:404});
    if(!canDownloadFile(store,user,key,{...object.customMetadata,contentType:object.httpMetadata?.contentType||'',size:String(object.size)}))throw new Error('FORBIDDEN: This file is restricted.');
    const isLogo=(store.settings||[]).some(row=>!row.deletedAt&&!row.archivedAt&&Array.isArray(row.logo)&&row.logo.some((logo:{key?:string})=>logo.key===key));
    if(isLogo) {
      validateLogoMetadata(object);
      const logo=await env.BUCKET?.get(key);
      if(!logo)return new Response('File not found',{status:404});
      await validateMediaUpload(new File([await logo.arrayBuffer()],object.customMetadata?.name||'logo',{type:object.httpMetadata?.contentType||''}),'logo');
    }
    const headers=fileResponseHeaders({contentType:object.httpMetadata?.contentType||'application/octet-stream',name:object.customMetadata?.name||'document',size:object.size,inline:params.get('inline')==='1'});
    let range;
    try { range=parseByteRange(request.headers.get('range'),object.size); }
    catch(error) {
      if(!(error instanceof MediaRangeError))throw error;
      headers.set('Content-Range',error.contentRange);headers.set('Content-Length','0');
      return new Response(null,{status:416,headers});
    }
    const file=await env.BUCKET?.get(key,range?{range:{offset:range.start,length:range.length}}:undefined);
    if(!file)return new Response('File not found',{status:404});
    return new Response(file.body,{status:range?206:200,headers:fileResponseHeaders({contentType:object.httpMetadata?.contentType||'application/octet-stream',name:object.customMetadata?.name||'document',size:object.size,inline:params.get('inline')==='1',range:range||undefined})});
  } catch(error) { return apiError(error); }
}
