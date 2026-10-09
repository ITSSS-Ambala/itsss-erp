import { NextResponse } from 'next/server';
import { apiError, checkOrigin, loadWorkspace, requestActor } from '../../../../lib/server';
import { managePassword } from '../../../../lib/hostinger/manage-password';
import { getHostingerConfig } from '../../../../lib/hostinger/config';
import { sessionCookieName } from '../../../../lib/hostinger/sessions';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { store, revision, user } = await loadWorkspace();
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Invalid password request.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 4096) { await reader.cancel(); throw new Error('Invalid password request.'); }
      chunks.push(item.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body.memberId !== 'string' || body.memberId.length > 200 || typeof body.password !== 'string' || !['reset', 'change'].includes(body.mode)) throw new Error('Choose a user and enter a new password.');
    if (body.revision !== revision) throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
    const result = await managePassword(store, revision, user, body, requestActor(request, user));
    const response = NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    if (result.signInAgain) response.cookies.set(sessionCookieName(), '', { httpOnly: true, secure: getHostingerConfig().secure, sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RATE_LIMIT:')) return NextResponse.json({ error: error.message.slice(12) }, { status: 429, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '900' } });
    return apiError(error);
  }
}
