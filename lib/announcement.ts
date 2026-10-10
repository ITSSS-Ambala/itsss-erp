import type { ERPRecord } from './schema.ts';

export const defaultAnnouncement = 'Welcome to our internal management app';
export function announcementFor(settings?: Partial<ERPRecord>) {
  const text = settings?.announcementText === undefined ? defaultAnnouncement : String(settings.announcementText).trim();
  return { text, enabled: settings?.announcementEnabled !== false && Boolean(text), animated: settings?.announcementAnimated !== false };
}
