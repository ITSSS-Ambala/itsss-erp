import { NextResponse } from 'next/server';
import { checkOrigin, apiError } from '../../../../lib/server';
import { getHostingerConfig } from '../../../../lib/hostinger/config';
import { login, safeReturnPath, sessionCookieName } from '../../../../lib/hostinger/sessions';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    if (Number(request.headers.get('content-length')) > 4096) throw new Error('Invalid sign-in request.');
    // Bound the stream as well; Content-Length alone is not authoritative.
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Invalid sign-in request.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 4096) { await reader.cancel(); throw new Error('Invalid sign-in request.'); }
      chunks.push(item.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body.email !== 'string' || body.email.length > 254 || typeof body.password !== 'string' || Buffer.byteLength(body.password) > 256) throw new Error('Enter a valid email and password.');
    const session = await login(body.email, body.password);
    if (!session) return NextResponse.json({ error: 'Email or password is incorrect.' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
    const response = NextResponse.json({ returnTo: safeReturnPath(body.returnTo) }, { headers: { 'Cache-Control': 'private, no-store' } });
    response.cookies.set(sessionCookieName(), session.token, { httpOnly: true, secure: getHostingerConfig().secure, sameSite: 'lax', path: '/', maxAge: session.maxAge });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RATE_LIMIT:')) return NextResponse.json({ error: error.message.slice(12) }, { status: 429, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '900' } });
    return apiError(error);
  }
}
