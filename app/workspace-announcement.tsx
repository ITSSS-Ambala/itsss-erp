'use client';
import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import { announcementFor } from '../lib/announcement';
import type { ERPRecord } from '../lib/schema';

export default function WorkspaceAnnouncement({settings,canEdit,onEdit}:{settings?:ERPRecord;canEdit:boolean;onEdit:()=>void}) {
  const announcement=announcementFor(settings);
  if(!announcement.enabled)return null;
  return <div className={`marquee-bar ${announcement.animated?'':'announcement-static'}`} aria-label="Workspace announcement"><div className="marquee-track"><span className="marquee-content">{announcement.text}</span>{announcement.animated&&<span className="marquee-content" aria-hidden="true">{announcement.text}</span>}</div>{canEdit&&<button className="announcement-edit" aria-label="Edit announcement" title="Edit announcement" onClick={onEdit}><Pencil size={15}/></button>}</div>;
}
export function AnnouncementEditor({settings,busy,error,close,save}:{settings?:ERPRecord;busy:boolean;error?:string;close:()=>void;save:(data:object)=>Promise<unknown>}) {
  const defaults=announcementFor(settings),[text,setText]=useState(defaults.text),[enabled,setEnabled]=useState(defaults.enabled),[animated,setAnimated]=useState(defaults.animated);
  const dialog=useRef<HTMLDivElement>(null);
  useEffect(()=>{dialog.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()},[]);
  async function submit(remove=false){if(await save({announcementText:remove?'':text.trim(),announcementEnabled:remove?false:enabled,announcementAnimated:animated}))close()}
  return <div className="modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)close()}}><div ref={dialog} className="record-modal announcement-dialog" role="dialog" aria-modal="true" aria-labelledby="announcement-title" onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();close()}if(e.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('textarea,input,button:not(:disabled)')||[]);if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus()}}}}>
    <div className="modal-header"><div><h2 id="announcement-title">Workspace announcement</h2><p>Edit the top bar text for everyone.</p></div><button className="icon-button" aria-label="Close announcement editor" disabled={busy} onClick={close}><X size={18}/></button></div>
    <form onSubmit={e=>{e.preventDefault();submit()}}><div className="modal-body"><label className="form-field"><span>Announcement text</span><textarea aria-label="Announcement text" maxLength={500} rows={4} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/><small>{text.length}/500 characters</small></label><label className="announcement-option"><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>Show announcement</label><label className="announcement-option"><input type="checkbox" checked={animated} disabled={busy} onChange={e=>setAnimated(e.target.checked)}/>Animate scrolling text</label>{error&&<p className="form-errors" role="alert">{error}</p>}</div>
    <div className="modal-footer"><button type="button" className="button danger" disabled={busy} onClick={()=>submit(true)}><Trash2 size={15}/>Remove announcement</button><button type="submit" className="button primary" disabled={busy||enabled&&!text.trim()}>{busy?'Saving…':'Save announcement'}</button></div></form>
  </div></div>;
}
