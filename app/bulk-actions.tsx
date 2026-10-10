'use client';
import { useEffect, useRef, useState } from 'react';
import { Archive, ChevronDown, Download, Trash2, X } from 'lucide-react';
import type { Field, Module, Store } from '../lib/schema';

type Props = { module: Module; fields: Field[]; store: Store; selected: string[]; matching: string[]; capabilities: Record<string,boolean>; busy: boolean; error?: string; clear: ()=>void; selectAll: ()=>void; exportSelected: ()=>void; run: (operation:string,data?:object)=>Promise<unknown> };
export default function BulkActions({module,fields,store,selected,matching,capabilities,busy,error,clear,selectAll,exportSelected,run}: Props) {
  const [open,setOpen]=useState(false),[operation,setOperation]=useState(''),[field,setField]=useState('status'),[value,setValue]=useState('');
  const root=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDivElement>(null);
  useEffect(()=>{const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false)};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close)},[]);
  useEffect(()=>{if(operation)dialog.current?.querySelector<HTMLElement>('select,button')?.focus()},[operation]);
  const assignmentFields=fields.filter(f=>f.relation==='employees'&&f.type==='relation');
  const statusField=fields.find(f=>f.key==='status'&&['select','radio'].includes(f.type));
  const choose=(next:string,key='status')=>{setOperation(next);setField(key);setValue('');setOpen(false)};
  async function apply(){const result=await run(operation,operation==='update'?{[field]:value}:{});if(result){setOperation('');clear()}}
  const activeField=fields.find(f=>f.key===field);
  const options=activeField?.relation?(store[activeField.relation]||[]).filter(r=>!r.deletedAt&&!r.archivedAt&&r.status!=='Inactive').map(r=>({value:r.id,label:r.name||r.id})):(activeField?.options||[]).map(label=>({value:label,label}));
  return <div className="bulk-selection-bar" ref={root}>
    <strong aria-live="polite">{selected.length} selected</strong>
    <div className="bulk-menu-anchor">
      <button className="button primary small" disabled={busy} aria-expanded={open} aria-haspopup="menu" onClick={()=>setOpen(!open)}>Actions <ChevronDown size={15}/></button>
      {open&&<div className="bulk-menu" role="menu" aria-label="Selected record actions" onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);root.current?.querySelector<HTMLButtonElement>('button')?.focus()}}}>
        {capabilities.edit&&statusField&&<button role="menuitem" onClick={()=>choose('update')}>Change status</button>}
        {capabilities.edit&&assignmentFields.map(f=><button role="menuitem" key={f.key} onClick={()=>choose('update',f.key)}>Set {f.label.toLowerCase()}</button>)}
        {capabilities.archive&&<button role="menuitem" onClick={()=>choose('archive')}><Archive size={16}/>Archive selected</button>}
        {capabilities.export&&<button role="menuitem" onClick={()=>{exportSelected();setOpen(false)}}><Download size={16}/>Export selected CSV</button>}
        {capabilities.delete&&<button role="menuitem" className="bulk-delete" onClick={()=>choose('delete')}><Trash2 size={16}/>Delete selected</button>}
        <button role="menuitem" onClick={()=>{clear();setOpen(false)}}><X size={16}/>Clear selection</button>
      </div>}
    </div>
    {matching.length>selected.length&&matching.length<=500&&<button className="button small" disabled={busy} onClick={selectAll}>Select all {matching.length} matching</button>}
    <button className="icon-button" aria-label="Clear selected records" disabled={busy} onClick={clear}><X size={16}/></button>
    {operation&&<div className="modal-scrim" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setOperation('')}}>
      <div ref={dialog} className="confirm-dialog bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-title" onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();setOperation('')}if(e.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('select,button:not(:disabled)')||[]);if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus()}}}}>
        <h2 id="bulk-title">{operation==='delete'?'Delete':operation==='archive'?'Archive':'Update'} {selected.length} {module.name.toLowerCase()}?</h2>
        <p>{operation==='delete'?'Selected records will move to the recycle bin and can be restored from Settings.':operation==='archive'?'Archived records retain their history and can be restored from Settings.':'This change applies to every selected record.'}</p>
        {operation==='update'&&<label className="form-field"><span>{activeField?.label}</span><select aria-label={activeField?.label} value={value} disabled={busy} onChange={e=>setValue(e.target.value)}><option value="">Choose {activeField?.label.toLowerCase()}</option>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>}
        {error&&<p className="form-errors" role="alert">{error}</p>}
        <div><button className="button" disabled={busy} onClick={()=>setOperation('')}>Cancel</button><button className={`button ${operation==='delete'?'danger':'primary'}`} disabled={busy||operation==='update'&&!value} onClick={apply}>{busy?'Saving…':operation==='delete'?'Delete selected':operation==='archive'?'Archive selected':'Apply to selected'}</button></div>
      </div>
    </div>}
  </div>;
}
