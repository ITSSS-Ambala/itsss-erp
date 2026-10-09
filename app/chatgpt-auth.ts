import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionCookieName, sessionIdentity, safeReturnPath, type ApplicationUser } from '../lib/hostinger/sessions';

// Existing ERP imports retain these helper names. Identity now comes from a
// verified server session; public identity headers are never trusted.
export type ChatGPTUser = ApplicationUser;
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const cookieStore = await cookies();
  return sessionIdentity(cookieStore.get(sessionCookieName())?.value);
}
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(returnTo: string): string { return `/login?return_to=${encodeURIComponent(safeReturnPath(returnTo))}`; }
