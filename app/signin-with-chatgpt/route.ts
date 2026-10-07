import { redirect } from 'next/navigation';
export function GET(request: Request) {
  const returnTo = new URL(request.url).searchParams.get('return_to') || '/';
  redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
}
