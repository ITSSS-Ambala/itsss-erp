import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError, checkOrigin } from '../../../../lib/server';
import { getHostingerConfig } from '../../../../lib/hostinger/config';
import { revokeSession, sessionCookieName } from '../../../../lib/hostinger/sessions';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const name = sessionCookieName();
    revokeSession((await cookies()).get(name)?.value);
    const config = getHostingerConfig();
    const response = NextResponse.redirect(new URL('/login', config.origin), 303);
    response.cookies.set(name, '', { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/', maxAge: 0 });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) { return apiError(error); }
}
