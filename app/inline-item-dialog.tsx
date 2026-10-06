'use client';
import {useEffect, useRef, useState} from 'react';
import {ArrowRight, ListPlus, X} from 'lucide-react';
import type {Field, Module} from '../lib/schema';

export default function InlineItemDialog({module, field, initialName, busy, error, save, close}: {
  module: Module; field: Field; initialName: string; busy: boolean; error?: string;
  save: (name: string) => Promise<void>; close: () => void;
}) {
  const [name, setName] = useState(initialName);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { if (error && !busy) input.current?.focus(); }, [error, busy]);
  return <div className="modal-scrim" onMouseDown={e => {if (e.target === e.currentTarget && !busy) close();}}>
    <div className="record-modal inline-item-modal" role="dialog" aria-modal="true" aria-labelledby="inline-item-title" ref={dialog}
      onKeyDown={e => {
        if (e.key === 'Escape') {e.stopPropagation(); if (!busy) close();}
        if (e.key === 'Tab') {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []);
          const first = items[0], last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) {e.preventDefault(); last?.focus();}
          else if (!e.shiftKey && document.activeElement === last) {e.preventDefault(); first?.focus();}
        }
      }}>
      <div className="modal-header"><div><div className="eyebrow">{module.name} · {field.label}</div><h2 id="inline-item-title">Create new item</h2><p>Add an option and continue with your current form.</p></div>
        <button type="button" className="icon-button" aria-label="Cancel new item" disabled={busy} onClick={close}><X size={18}/></button></div>
      <form onSubmit={async e => {e.preventDefault(); if (name.trim() && !busy) await save(name.trim());}}>
        <div className="modal-body"><label className="form-field"><span>New {field.label.toLowerCase()}</span><input ref={input} required maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder={`Enter ${field.label.toLowerCase()}`}/></label>
          <p className="inline-item-hint"><ListPlus size={15}/>Saved to this dropdown for everyone who can access it.</p>
          {error && <div className="form-errors" role="alert">{error}</div>}</div>
        <div className="modal-footer"><span className="form-note">Your current draft is kept.</span><div><button type="button" className="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Create & select'}<ArrowRight size={16}/></button></div></div>
      </form>
    </div>
  </div>;
}
