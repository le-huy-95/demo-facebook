import { redirect } from 'next/navigation';
import { getAuthStatus } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  try {
    const { data } = await getAuthStatus();
    redirect(data.connected ? '/shops' : '/login');
  } catch {
    redirect('/login');
  }
}
