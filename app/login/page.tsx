import LoginForm from './login-form';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in | ITSSS Business Hub' };
export default async function Login({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const params = await searchParams;
  return <LoginForm returnTo={params.return_to || '/'} />;
}
