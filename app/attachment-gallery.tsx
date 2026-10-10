import { Download, FileText, Paperclip } from 'lucide-react';

type Attachment = { key?: string; name?: string; type?: string; size?: number };
export default function AttachmentGallery({files,title='Attachments'}:{files?: Attachment[];title?:string}) {
  const attachments=Array.isArray(files)?files:[];
  return <section className="attachment-gallery" aria-label={title}>
    <h3><Paperclip size={17}/>{title} <span>{attachments.length}</span></h3>
    {attachments.length?<div className="attachment-grid">{attachments.map((file,index)=>{
      const url=file.key?'/api/files?key='+encodeURIComponent(file.key):undefined;
      const image=['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(file.type||'');
      return <div className="attachment-card" key={file.key||index}>
        {image&&url?<a href={url+'&inline=1'} target="_blank" rel="noreferrer" aria-label={`Preview ${file.name||'image'}`}><img loading="lazy" src={url+'&inline=1'} alt={file.name||'Project image'}/></a>:<div className="attachment-file-icon"><FileText size={28}/></div>}
        <div><strong>{file.name||'File'}</strong>{file.size!==undefined&&<small>{file.size<1024?`${file.size} B`:`${Math.ceil(file.size/1024)} KB`}</small>}{url?<a href={url} target="_blank" rel="noreferrer"><Download size={14}/>Download</a>:<small>File unavailable</small>}</div>
      </div>;
    })}</div>:<p className="attachment-empty">No files attached yet. Use Edit record to add files or images.</p>}
  </section>;
}
