'use client';
import {useEffect,useRef,useState} from 'react';
import {Building2,ImagePlus,LoaderCircle,Trash2} from 'lucide-react';
import {ITSSS_LOGO_SRC} from '../lib/branding';
import './company-logo-control.css';

type LogoFile={name:string;url:string;key:string;size:number;type:string};
const previewURL=(url:string)=>url+(url.includes('?')?'&':'?')+'inline=1';
export default function CompanyLogoControl({value=[],recordId,disabled,onChange,onUploading,onToast}: {
 value?:LogoFile[];recordId:string;disabled?:boolean;onChange:(value:LogoFile[])=>void;onUploading:(value:boolean)=>void;onToast:(message:string)=>void;
}) {
 const picker=useRef<HTMLInputElement>(null),mounted=useRef(true),request=useRef<AbortController|null>(null);
 const [uploading,setUploading]=useState(false),[preview,setPreview]=useState(''),[failed,setFailed]=useState(false),[error,setError]=useState('');
 const file=value[0],url=preview||(file?.url?previewURL(file.url):ITSSS_LOGO_SRC);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort()}},[]);
 useEffect(()=>{setFailed(false)},[url]);
 useEffect(()=>()=>{if(preview.startsWith('blob:'))URL.revokeObjectURL(preview)},[preview]);
 async function uploadLogo(file:File){
  if(disabled||uploading)return;
  setError('');
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){setError('Choose a PNG, JPG, WebP or GIF image.');return;}
  if(!file.size||file.size>5*1024*1024){setError('Choose a logo up to 5 MB.');return;}
  setUploading(true);onUploading(true);
  const localURL=URL.createObjectURL(file);request.current=new AbortController();
  try{
   await new Promise<void>((resolve,reject)=>{const image=new Image();image.onload=()=>image.naturalWidth&&image.naturalHeight?resolve():reject(new Error('Choose a valid image.'));image.onerror=()=>reject(new Error('This image could not be opened.'));image.src=localURL});
   if(!mounted.current)return;
   setPreview(localURL);
   const form=new FormData();form.append('file',file);form.append('module','settings');form.append('recordId',recordId);
   const response=await fetch('/api/files',{method:'POST',body:form,signal:request.current.signal}),data:any=await response.json();
   if(!response.ok)throw new Error(data.error||'The logo could not be uploaded.');
   if(mounted.current){onChange([data]);setPreview('');onToast('Logo ready. Save company profile to apply it.');}
  }catch(cause){if(mounted.current){setError(cause instanceof Error?cause.message:'The logo could not be uploaded.');setPreview('');}}
  finally{URL.revokeObjectURL(localURL);if(mounted.current){setUploading(false);onUploading(false)}}
 }
 return <div className="company-logo-control form-field wide"><span>Company logo</span><div className="company-logo-box">
  <div className="company-logo-preview">{url&&!failed?<img src={url} alt="Company logo preview" onError={()=>setFailed(true)}/>:<Building2 size={36} strokeWidth={1.5}/>}</div>
  <div className="company-logo-info"><strong>{uploading?'Uploading logo…':file?'Your company logo':'ITSSS default logo'}</strong><p>PNG, JPG, WebP or GIF · Up to 5 MB<br/>Save your company profile to apply changes.</p>{file&&!uploading&&<small>{file.name}</small>}<div className="company-logo-actions"><button type="button" className="button small" disabled={disabled||uploading} onClick={()=>picker.current?.click()}>{uploading?<LoaderCircle size={14} className="logo-loading"/>:<ImagePlus size={14}/>} Change logo</button>{file&&<button type="button" className="button small" disabled={disabled||uploading} onClick={()=>{onChange([]);setPreview('');setError('');onToast('ITSSS default logo restored in the draft. Save company profile to apply it.')}}><Trash2 size={14}/>Use default logo</button>}</div></div>
  <input ref={picker} type="file" className="hidden" aria-label="Upload company logo" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled||uploading} onChange={async event=>{const input=event.currentTarget,file=input.files?.[0];if(file)await uploadLogo(file);input.value=''}}/>
 </div>{error&&<div className="form-errors" role="alert">{error}</div>}{failed&&url&&<small className="company-logo-warning">Preview unavailable. You can replace this logo with a new image.</small>}</div>;
}
