'use client';

import { useEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck, Clock3, PackageOpen, RefreshCw, X } from 'lucide-react';
import type { ERPRecord } from '../lib/schema';
import './notification-bell.css';

export default function NotificationBell({ initialItems, open, onOpenChange, onOpen, onSync }: {
  initialItems: ERPRecord[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (notification: ERPRecord) => Promise<void>;
  onSync: (items: ERPRecord[]) => void;
}) {
  const [items, setItems] = useState(initialItems), [refreshError, setRefreshError] = useState(''), [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false);
  const container = useRef<HTMLDivElement>(null), mounted = useRef(true), controller = useRef<AbortController | null>(null), version = useRef(0), reading = useRef(false);
  const sync = useRef(onSync);
  useEffect(() => { sync.current = onSync; }, [onSync]);
  const unread = items.filter(item => !item.read).length;
  useEffect(() => { version.current++; setItems(initialItems); }, [initialItems]);

  async function refresh() {
    if (document.hidden || controller.current || reading.current) return;
    const request = new AbortController(), current = ++version.current;
    controller.current = request; setRefreshing(true);
    try {
      const response = await fetch('/api/notifications', { cache: 'no-store', signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Notifications could not refresh.');
      if (mounted.current && current === version.current) { setItems(data.notifications); sync.current(data.notifications); setRefreshError(''); }
    } catch (error) {
      if (mounted.current && !request.signal.aborted && current === version.current) setRefreshError(error instanceof Error ? error.message : 'Notifications could not refresh.');
    } finally { if (controller.current === request) controller.current = null; if (mounted.current) setRefreshing(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const interval = setInterval(() => { void refresh(); }, 15000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { mounted.current = false; clearInterval(interval); controller.current?.abort(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) onOpenChange(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, onOpenChange]);

  async function markRead(ids?: string[]): Promise<boolean> {
    if (reading.current) return false;
    reading.current = true; setBusy(true); setReadError('');
    controller.current?.abort(); controller.current = null;
    const current = ++version.current;
    try {
      const response = await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { ids } : { all: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Read status could not be saved.');
      if (mounted.current && current === version.current) { setItems(data.notifications); sync.current(data.notifications); setRefreshError(''); }
      return true;
    } catch (error) { if (mounted.current) setReadError(error instanceof Error ? error.message : 'Read status could not be saved.'); return false; }
    finally { reading.current = false; if (mounted.current) setBusy(false); }
  }
  async function openItem(item: ERPRecord) {
    if (!item.read && !await markRead([item.id])) return;
    await onOpen(item); onOpenChange(false);
  }

  return <div className="popover-anchor notification-anchor" ref={container}>
    <button type="button" className="icon-button" aria-label={refreshError ? 'Notifications unavailable' : `Notifications, ${unread} unread`} aria-expanded={open} aria-controls="notification-center" onClick={() => onOpenChange(!open)}>
      <Bell size={18} strokeWidth={1.8} />{!refreshError && unread > 0 && <span className="notification-dot" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <section id="notification-center" className="notification-popover notification-center" aria-label="Your notifications">
      <div className="notification-heading"><div><h3>Notifications</h3><p>{refreshError ? 'Refresh needed' : `${unread} unread · Your personal inbox`}</p></div><button type="button" className="icon-button" aria-label="Close notifications" onClick={() => onOpenChange(false)}><X size={16} /></button></div>
      <div className="notification-toolbar"><button type="button" disabled={!unread || busy || Boolean(refreshError)} onClick={() => { void markRead(); }}><CheckCheck size={13} />Mark all as read</button><button type="button" disabled={refreshing || busy} onClick={() => { void refresh(); }}><RefreshCw size={12} />{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
      {(refreshError || readError) && <p className="notification-error" role="alert">{refreshError || readError}</p>}
      {items.length ? <ul className="notification-list">{items.map(item => <li key={item.id} className={item.read ? 'notification-read' : 'notification-unread'}>
        <button type="button" className="notification-open" disabled={busy} onClick={() => { void openItem(item); }}><span className={`result-icon notification-${item.severity || 'info'}`}>{item.type === 'Low Stock' ? <PackageOpen size={16} /> : <Clock3 size={16} />}</span><span><small className="notification-type">{item.type}</small><strong>{item.name}</strong><span className="notification-message">{item.message}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></span>{!item.read && <i className="notification-unread-dot" aria-label="Unread" />}</button>
        {!item.read && <button type="button" className="notification-mark-read" aria-label={`Mark ${item.name} as read`} title="Mark as read" disabled={busy} onClick={() => { void markRead([item.id]); }}><Check size={14} /></button>}
      </li>)}</ul> : !refreshError && <div className="notification-empty"><CheckCheck size={24} /><strong>No notifications yet</strong><p>Updates and reminders for your responsibilities appear here.</p></div>}
    </section>}
  </div>;
}
