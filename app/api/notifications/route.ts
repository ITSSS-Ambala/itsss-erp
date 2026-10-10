import { loadWorkspace, loadNotificationWorkspace, notificationResponseData, apiError, checkOrigin } from '../../../lib/server';
import { markNotificationsRead } from '../../../lib/hostinger/notification-reads';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const { store, user } = await loadNotificationWorkspace();
    return Response.json(notificationResponseData(store, user), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { store, user } = await loadWorkspace();
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.all !== true && (!Array.isArray(body.ids) || body.ids.length > 1000)) throw new Error('Choose notifications to mark as read.');
    markNotificationsRead(store, user, body.all === true ? undefined : body.ids);
    return Response.json(notificationResponseData(store, user), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return apiError(error); }
}
